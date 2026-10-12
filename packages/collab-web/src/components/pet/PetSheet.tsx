import { ArrowLeft, Check, ExternalLink, LoaderCircle, RotateCcw, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { closePetPip, openPetPip, petPipSupported, usePetPipWindow } from "../../lib/pet-pip";
import {
	MASCOT,
	PET_SIZE_MAX,
	PET_SIZE_MIN,
	setPetSettings,
	setPetSpot,
	usePetSettings,
	usePetSpot,
} from "../../lib/pet-settings";
import {
	loadPetdexList,
	loadPetdexSheet,
	PREVIEW_FRAMES,
	type PetdexList,
	type PetdexPet,
	petdexPreviewUrl,
	pruneSheets,
	searchPets,
} from "../../lib/petdex";
import { useRequest } from "../../lib/use-request";
import { Sheet } from "../shell/Sheet";
import { Mascot } from "./Mascot";
import { PetFigure } from "./PetFigure";
import "./pet.css";

/** Height of one gallery row in px; the list draws only the rows in view. */
const ROW_PX = 56;
const LIST_PX = 336;
/** Rows drawn beyond the visible ones, so a quick scroll shows no blanks. */
const OVERSCAN = 4;

function SheetHead({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose: () => void }): ReactNode {
	return (
		<div className="sh-sheet-head">
			<div className="tl-pet-sheet-title">
				{onBack && (
					<button type="button" className="sh-btn sh-btn-icon" onClick={onBack} aria-label="Back to pet settings">
						<ArrowLeft size={16} />
					</button>
				)}
				<div className="sh-sheet-title">{title}</div>
			</div>
			<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
				<X size={16} />
			</button>
		</div>
	);
}

/** The pet's settings: on or off, which pet, its size, roaming and the pop-out. */
export function PetSheet({ onClose }: { onClose: () => void }): ReactNode {
	const [gallery, setGallery] = useState(false);
	return (
		<Sheet label="Pet" size={gallery ? "wide" : undefined} onClose={onClose}>
			{gallery ? (
				<>
					<SheetHead title="Choose a pet" onBack={() => setGallery(false)} onClose={onClose} />
					<Gallery onDone={() => setGallery(false)} />
				</>
			) : (
				<>
					<SheetHead title="Pet" onClose={onClose} />
					<Settings onChoose={() => setGallery(true)} />
				</>
			)}
		</Sheet>
	);
}

function Settings({ onChoose }: { onChoose: () => void }): ReactNode {
	const settings = usePetSettings();
	const spot = usePetSpot();
	const pipWindow = usePetPipWindow();
	const [popError, setPopError] = useState<string | null>(null);
	const { pick, size } = settings;
	const popOut = async (): Promise<void> => {
		setPopError(await openPetPip());
	};
	return (
		<div className="tl-pet-sheet-body">
			<label className="tl-pet-sheet-check">
				<input
					type="checkbox"
					checked={settings.enabled}
					onChange={e => setPetSettings({ enabled: e.currentTarget.checked })}
				/>
				<span>Show the pet</span>
			</label>

			<div className="tl-pet-sheet-current">
				<div className="tl-pet-sheet-art">
					<PetFigure pick={pick} state="idle" size={56} />
				</div>
				<div className="tl-pet-sheet-who">
					<div className="tl-pet-sheet-name">{pick?.name ?? "Pi, the omp mascot"}</div>
					<div className="sh-field-hint">{pick ? `by ${pick.by} · petdex.dev` : "Original art, built in"}</div>
				</div>
				<button type="button" className="sh-btn" onClick={onChoose}>
					Change
				</button>
			</div>

			<label className="sh-field">
				<span className="sh-field-label">Size · {size} px</span>
				<input
					type="range"
					className="tl-pet-sheet-slider"
					min={PET_SIZE_MIN}
					max={PET_SIZE_MAX}
					step={2}
					value={size}
					onChange={e => setPetSettings({ size: Number(e.currentTarget.value) })}
				/>
				<span className="sh-field-hint tl-pet-sheet-fine">Hold Alt and scroll over the pet to resize it.</span>
			</label>

			<label className="tl-pet-sheet-check tl-pet-sheet-hinted">
				<input
					type="checkbox"
					checked={settings.roam}
					onChange={e => setPetSettings({ roam: e.currentTarget.checked })}
				/>
				<span className="tl-pet-sheet-text">
					Roam
					<span className="sh-field-hint">
						While nothing is happening, the pet wanders along the bottom of the screen.
					</span>
				</span>
			</label>

			<div className="tl-pet-sheet-actions">
				{petPipSupported() && (
					<button type="button" className="sh-btn" onClick={pipWindow ? closePetPip : () => void popOut()}>
						<ExternalLink size={14} /> {pipWindow ? "Bring it back" : "Pop out"}
					</button>
				)}
				{spot !== null && (
					<button type="button" className="sh-btn" onClick={() => setPetSpot(null)}>
						<RotateCcw size={14} /> Reset position
					</button>
				)}
			</div>
			{popError !== null && <div className="sh-connect-error">{popError}</div>}
			<p className="sh-field-hint">
				Drag the pet to move it, click it for its status, Shift-click to pop it out. Its settings stay on this
				device.
			</p>
		</div>
	);
}

function Gallery({ onDone }: { onDone: () => void }): ReactNode {
	const settings = usePetSettings();
	const load = useCallback(() => loadPetdexList(), []);
	const { state, reload } = useRequest<PetdexList>(load);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const choosePet = async (pet: PetdexPet): Promise<void> => {
		if (busy !== null) return;
		setBusy(pet.slug);
		setError(null);
		try {
			// The sheet downloads (and is kept for offline use) before the choice changes, so a failure leaves the current pet.
			await loadPetdexSheet(pet.sheet);
			setPetSettings({ choice: pet.slug, pick: pet });
			await pruneSheets(pet.sheet);
			onDone();
		} catch (err) {
			setError(`Could not load ${pet.name}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(null);
		}
	};
	const chooseMascot = (): void => {
		setPetSettings({ choice: MASCOT, pick: null });
		void pruneSheets(null);
		onDone();
	};

	const pets = state.status === "ready" ? state.value.pets : null;
	const found = useMemo(() => (pets === null ? [] : searchPets(pets, query)), [pets, query]);

	return (
		<div className="tl-pet-sheet-body">
			<p className="sh-field-hint">
				Pets from petdex.dev are user-submitted fan art. Opening this list contacts petdex.dev and
				assets.petdex.dev.
			</p>
			<button
				type="button"
				className="tl-pet-gal-row tl-pet-gal-mascot"
				aria-pressed={settings.choice === MASCOT}
				onClick={chooseMascot}
			>
				<span className="tl-pet-gal-thumb">
					<Mascot state="idle" size={40} />
				</span>
				<span className="tl-pet-gal-text">
					<span className="tl-pet-gal-name">Pi, the omp mascot</span>
					<span className="sh-field-hint">Original art, built in</span>
				</span>
				{settings.choice === MASCOT && <Check size={16} />}
			</button>

			<label className="tl-pet-gal-search">
				<Search size={14} />
				<input
					type="search"
					className="sh-input"
					placeholder="Search petdex by name, kind or creator"
					aria-label="Search petdex"
					value={query}
					onChange={e => setQuery(e.currentTarget.value)}
				/>
			</label>

			{error !== null && <div className="sh-connect-error">{error}</div>}
			{state.status === "loading" && (
				<div className="sh-companion-empty tl-pet-gal-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading petdex…
				</div>
			)}
			{state.status === "error" && (
				<div className="tl-pet-gal-status">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						Try again
					</button>
				</div>
			)}
			{state.status === "ready" && (
				<>
					<div className="sh-field-hint" aria-live="polite">
						{state.value.stale && "Showing the copy saved on this device. "}
						{found.length === 1 ? "1 pet" : `${found.length.toLocaleString()} pets`}
					</div>
					<PetList pets={found} chosen={settings.choice} busy={busy} onChoose={pet => void choosePet(pet)} />
				</>
			)}
		</div>
	);
}

interface PetListProps {
	pets: readonly PetdexPet[];
	chosen: string;
	busy: string | null;
	onChoose(pet: PetdexPet): void;
}

/** A fixed-row list that draws only the rows in view: the gallery holds thousands of pets. */
function PetList({ pets, chosen, busy, onChoose }: PetListProps): ReactNode {
	const scroller = useRef<HTMLDivElement>(null);
	const [top, setTop] = useState(0);
	// A new search starts at the top.
	useEffect(() => {
		if (scroller.current !== null) scroller.current.scrollTop = 0;
		setTop(0);
	}, [pets]);
	const first = Math.max(0, Math.floor(top / ROW_PX) - OVERSCAN);
	const last = Math.min(pets.length, Math.ceil((top + LIST_PX) / ROW_PX) + OVERSCAN);
	return (
		<div
			ref={scroller}
			className="tl-pet-gal-list"
			style={{ height: LIST_PX }}
			onScroll={e => setTop(e.currentTarget.scrollTop)}
		>
			<div className="tl-pet-gal-spacer" style={{ height: pets.length * ROW_PX }}>
				{pets.slice(first, last).map((pet, i) => (
					<button
						key={pet.slug}
						type="button"
						className="tl-pet-gal-row"
						style={{ top: (first + i) * ROW_PX, height: ROW_PX }}
						aria-pressed={pet.slug === chosen}
						disabled={busy !== null}
						onClick={() => onChoose(pet)}
					>
						<Thumb pet={pet} />
						<span className="tl-pet-gal-text">
							<span className="tl-pet-gal-name">
								{pet.name} <span className="tl-pet-gal-kind">{pet.kind}</span>
							</span>
							<span className="sh-field-hint">by {pet.by} · petdex.dev</span>
						</span>
						{busy === pet.slug ? (
							<LoaderCircle size={16} className="sh-spin" />
						) : (
							pet.slug === chosen && <Check size={16} />
						)}
					</button>
				))}
			</div>
		</div>
	);
}

/** petdex's own preview of a pet: its idle row, six frames in one 55 KB strip, stepped through by CSS. */
function Thumb({ pet }: { pet: PetdexPet }): ReactNode {
	const [failed, setFailed] = useState(false);
	return (
		<span className="tl-pet-gal-thumb">
			{failed ? (
				<span className="tl-pet-gal-initial" aria-hidden>
					{pet.name.slice(0, 1).toUpperCase()}
				</span>
			) : (
				<img
					className="tl-pet-thumb-strip"
					src={petdexPreviewUrl(pet.slug)}
					alt=""
					loading="lazy"
					decoding="async"
					draggable={false}
					referrerPolicy="no-referrer"
					style={{ width: `${PREVIEW_FRAMES * 100}%` }}
					onError={() => setFailed(true)}
				/>
			)}
		</span>
	);
}
