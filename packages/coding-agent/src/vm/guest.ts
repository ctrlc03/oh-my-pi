/**
 * What `omp vm` puts inside a guest: the provisioning scripts, the host-services shim, the git and
 * `gh` configuration that sends GitHub traffic to the host, and omp's model config. Pure text
 * generation; the CLI runs it.
 */
import type { VmGuestEndpoints } from "./driver";
import type { VmRecord } from "./types";

/** Port of the guest-local shim that forwards to the host's services for this VM. */
export const GUEST_SHIM_PORT = 4000;
export const GUEST_SHIM_URL = `http://127.0.0.1:${GUEST_SHIM_PORT}`;
/** Guest-local socket for `gh` (`http_unix_socket`), relative to the user's home. */
export const GUEST_GH_SOCKET = ".omp-vm/host.sock";
/**
 * The token `gh` is configured with in the guest (`~/.config/gh/hosts.yml`): it refuses to run
 * without one, and the host replaces whatever it sends with the VM's installation token.
 */
export const GUEST_GH_TOKEN_PLACEHOLDER = "omp-vm-host-adds-the-token";

/** `~/.config/gh/hosts.yml`: a placeholder login, so `gh` runs in every shell and service without an environment variable. */
export function guestGhHostsYaml(): string {
	return [
		"github.com:",
		`    oauth_token: ${GUEST_GH_TOKEN_PLACEHOLDER}`,
		"    user: omp-vm",
		"    git_protocol: https",
		"",
	].join("\n");
}

export interface GuestIdentity {
	name: string;
	email: string;
}

export interface GuestProvisionOptions {
	record: VmRecord;
	endpoints: VmGuestEndpoints;
	/** Providers the host can serve; each is routed to the shim with `transport: pi-native`. */
	providers: string[];
	/** The fork's installer, e.g. `https://ctrlc03.github.io/oh-my-pi/install.sh`. */
	installerUrl: string;
	identity: GuestIdentity;
}

/** Single-quotes `value` for a POSIX shell. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `~/.omp/agent/models.yml`: every provider goes through the host gateway; the guest holds no credential. */
export function guestModelsYaml(providers: readonly string[]): string {
	const lines = [
		"# Written by `omp vm`: model calls go to the host through the VM's socket.",
		"# The host adds the credentials; this VM never sees them. `apiKey` is a placeholder.",
		"providers:",
	];
	for (const provider of [...providers].sort()) {
		lines.push(
			`  ${JSON.stringify(provider)}:`,
			`    baseUrl: ${GUEST_SHIM_URL}`,
			"    apiKey: vm",
			"    transport: pi-native",
		);
	}
	return `${lines.join("\n")}\n`;
}

/** systemd user unit that exposes the host's services for this VM on 127.0.0.1:4000. */
export function guestShimUnit(endpoints: VmGuestEndpoints): string {
	return [
		"[Unit]",
		"Description=omp VM: host services (model gateway, git) on 127.0.0.1:4000",
		"",
		"[Service]",
		`ExecStart=/usr/bin/socat TCP-LISTEN:${GUEST_SHIM_PORT},bind=127.0.0.1,fork,reuseaddr ${endpoints.hostServices}`,
		"Restart=always",
		"RestartSec=1",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

/** systemd user unit that exposes the same services on `~/.omp-vm/host.sock`, where `gh` sends its API calls. */
export function guestGhSocketUnit(endpoints: VmGuestEndpoints): string {
	return [
		"[Unit]",
		"Description=omp VM: host services for gh on ~/" + GUEST_GH_SOCKET,
		"",
		"[Service]",
		"ExecStartPre=/bin/mkdir -p %h/.omp-vm",
		`ExecStart=/usr/bin/socat UNIX-LISTEN:%h/${GUEST_GH_SOCKET},fork,unlink-early,mode=600 ${endpoints.hostServices}`,
		"Restart=always",
		"RestartSec=1",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

/**
 * `git config --global` lines that send every github.com remote (HTTPS or SSH form) to the host: rewritten to
 * `http://github.com/`, which git sends through the shim as its HTTP proxy. Remote URLs still name github.com, so
 * `gh` recognizes the repository.
 */
export function guestGitProxyConfig(): string[] {
	const key = shellQuote("url.http://github.com/.insteadOf");
	return [
		`git config --global --unset-all ${key} || true`,
		...["https://github.com/", "git@github.com:", "ssh://git@github.com/"].map(
			from => `git config --global --add ${key} ${shellQuote(from)}`,
		),
		`git config --global ${shellQuote("http.http://github.com/.proxy")} ${GUEST_SHIM_URL}`,
	];
}

function proxyEnvLines(proxy: string | undefined): string[] {
	if (!proxy) return [];
	return [
		`http_proxy=${proxy}`,
		`https_proxy=${proxy}`,
		`HTTP_PROXY=${proxy}`,
		`HTTPS_PROXY=${proxy}`,
		// 10.0.2.100 is QEMU's address for the host's services: reached directly, never through the proxy.
		"no_proxy=localhost,127.0.0.1,10.0.2.100",
		"NO_PROXY=localhost,127.0.0.1,10.0.2.100",
	];
}

/** Root part: packages, gh, the proxy environment, gh's placeholder token, lingering. Idempotent. */
export function guestSystemScript(opts: GuestProvisionOptions, user: string): string {
	const proxy = opts.endpoints.egressProxy;
	const envLines = proxyEnvLines(proxy);
	return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
${envLines.map(line => `export ${line}`).join("\n")}
echo "omp-vm: system setup"
${
	proxy
		? `# Every connection leaves through the host's proxy.
for line in ${envLines.map(shellQuote).join(" ")}; do
	key="\${line%%=*}"
	grep -q "^\${key}=" /etc/environment && sed -i "/^\${key}=/d" /etc/environment
	printf '%s\\n' "$line" >> /etc/environment
done
printf 'Acquire::http::Proxy "%s";\\nAcquire::https::Proxy "%s";\\n' ${shellQuote(proxy)} ${shellQuote(proxy)} > /etc/apt/apt.conf.d/90omp-proxy
`
		: ""
}hostnamectl set-hostname ${shellQuote(`vm-${opts.record.name}`)} || true
echo "omp-vm: installing packages"
apt-get update -q
apt-get install -y -q git tmux socat curl ca-certificates build-essential unzip jq
if ! dpkg -s gh >/dev/null 2>&1; then
	echo "omp-vm: installing the GitHub CLI"
	install -d -m 0755 /etc/apt/keyrings
	curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
	chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
	apt-get update -q
	apt-get install -y -q gh
fi
loginctl enable-linger ${shellQuote(user)}
echo "omp-vm: system setup done"
`;
}

/** User part: the shims, omp's model config, git identity and GitHub routing, omp itself, the repositories. */
export function guestUserScript(opts: GuestProvisionOptions): string {
	const proxy = opts.endpoints.egressProxy;
	const envLines = proxyEnvLines(proxy);
	const repos = opts.record.repos.map(shellQuote).join(" ");
	return `set -euo pipefail
${envLines.map(line => `export ${line}`).join("\n")}
export PATH="$HOME/.local/bin:$PATH"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
echo "omp-vm: host services shim"
mkdir -p ~/.config/systemd/user ~/.config/environment.d ~/.config/gh ~/.omp/agent ~/src
cat > ~/.config/systemd/user/omp-vm-host.service <<'OMP_VM_EOF'
${guestShimUnit(opts.endpoints)}OMP_VM_EOF
cat > ~/.config/systemd/user/omp-vm-gh.service <<'OMP_VM_EOF'
${guestGhSocketUnit(opts.endpoints)}OMP_VM_EOF
${
	envLines.length > 0
		? `printf '%s\\n' ${envLines.map(shellQuote).join(" ")} > ~/.config/environment.d/50-omp-proxy.conf\n`
		: "rm -f ~/.config/environment.d/50-omp-proxy.conf\n"
}systemctl --user daemon-reload
systemctl --user enable omp-vm-host.service omp-vm-gh.service >/dev/null 2>&1
systemctl --user restart omp-vm-host.service omp-vm-gh.service
for _ in $(seq 1 30); do
	curl -fsS --max-time 2 ${GUEST_SHIM_URL}/healthz >/dev/null 2>&1 && break
	sleep 1
done
curl -fsS --max-time 5 ${GUEST_SHIM_URL}/healthz >/dev/null || { echo "omp-vm: the host's services are not reachable from the VM (is the supervisor running?)" >&2; exit 1; }
cat > ~/.omp/agent/models.yml <<'OMP_VM_EOF'
${guestModelsYaml(opts.providers)}OMP_VM_EOF
# The companion's disk guard warns below 40 GB free by default, more than a VM disk holds:
# scale its limit to this disk unless a device already changed it.
[ -f ~/.omp/agent/collab-companion-disk.json ] || printf '{"settings":{"limitGb":%s}}\\n' ${guestDiskLimitGb(opts.record.diskGiB)} > ~/.omp/agent/collab-companion-disk.json
echo "omp-vm: git identity and GitHub routing"
git config --global user.name ${shellQuote(opts.identity.name)}
git config --global user.email ${shellQuote(opts.identity.email)}
git config --global init.defaultBranch main
# The VM holds no GitHub credential: git and gh reach GitHub through the host, which adds the token.
${guestGitProxyConfig().join("\n")}
printf 'git_protocol: https\\nhttp_unix_socket: %s\\n' "$HOME/${GUEST_GH_SOCKET}" > ~/.config/gh/config.yml
cat > ~/.config/gh/hosts.yml <<'OMP_VM_EOF'
${guestGhHostsYaml()}OMP_VM_EOF
chmod 0600 ~/.config/gh/hosts.yml
for _ in $(seq 1 30); do [ -S "$HOME/${GUEST_GH_SOCKET}" ] && break; sleep 1; done
echo "omp-vm: installing omp"
curl -fsSL ${shellQuote(opts.installerUrl)} | sh -s -- --yes --no-login --no-desktop --no-open
# Sessions start in tmux with no one at the keyboard: the first-run wizard would block them.
# Logins live on the host, so it has nothing to set up here.
~/.local/bin/omp config set setupVersion 1000 >/dev/null
for repo in ${repos}; do
	target="$HOME/src/$repo"
	if [ -d "$target/.git" ]; then
		echo "omp-vm: $repo already cloned"
	else
		echo "omp-vm: cloning $repo"
		mkdir -p "$(dirname "$target")"
		git clone "https://github.com/$repo.git" "$target"
	fi
	if [ -f "$target/.omp/vm-setup" ]; then
		echo "omp-vm: running $repo/.omp/vm-setup"
		(cd "$target" && bash .omp/vm-setup) || echo "omp-vm: warning: $repo/.omp/vm-setup failed" >&2
	fi
done
echo "omp-vm: provisioning done"
`;
}

/** Free-space limit for the VM companion's disk guard: a tenth of the disk, at least 2 GB. */
export function guestDiskLimitGb(diskGiB: number): number {
	return Math.max(2, Math.round(diskGiB / 10));
}

/** Pulls the pairing URL out of `omp companion --pair` output. */
export function parsePairUrl(output: string): string | null {
	const match = /pair a device: scan the code or open (\S+)/.exec(output);
	return match ? match[1] : null;
}
