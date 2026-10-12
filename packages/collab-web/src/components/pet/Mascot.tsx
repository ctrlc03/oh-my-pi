import type { JSX } from "react";
import type { PetState } from "../../lib/pet-state";
import "./mascot.css";

export interface MascotProps {
	state: PetState;
	/** Rendered box width in CSS px; height follows the art's aspect ratio (192:208 like petdex cells). */
	size: number;
	/** Freeze to one still pose per state (prefers-reduced-motion, or a hidden page). */
	still?: boolean;
}

const BODY = "M96 54C128 54 150 78 150 108C150 138 134 160 96 160C58 160 42 138 42 108C42 78 64 54 96 54Z";
const SPARKLE = "M0-9Q1.5-1.5 9 0Q1.5 1.5 0 9Q-1.5 1.5-9 0Q-1.5-1.5 0-9Z";
/** The omp π mark, same outline as the app logo. */
const GLYPH = "M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z";

/**
 * "Pi" — the omp mascot: a round pink blob whose belly carries the π mark.
 * All motion is CSS keyframes keyed off `data-state`; every colour is a `--pet-*` token.
 */
export function Mascot({ state, size, still }: MascotProps): JSX.Element {
	return (
		<svg
			className="tl-pet"
			data-state={state}
			data-still={still ? "true" : undefined}
			viewBox="0 0 192 208"
			width={size}
			height={(size * 208) / 192}
			aria-hidden="true"
			focusable="false"
		>
			<g transform="translate(96 188) scale(.9) translate(-96 -188)">
				<ellipse className="tl-pet-shadow tl-pet-c-shadow" cx="96" cy="189" rx="44" ry="6.5" />
				<g className="tl-pet-flip">
					<g className="tl-pet-dust">
						<circle className="tl-pet-puff tl-pet-c-dust" cx="50" cy="183" r="6" />
						<circle className="tl-pet-puff tl-pet-puff-b tl-pet-c-dust" cx="42" cy="180" r="4.5" />
					</g>
					<g className="tl-pet-hop">
						<g className="tl-pet-lean">
							<g className="tl-pet-squash">
								<g transform="translate(96 56)">
									<g className="tl-pet-antenna">
										<g className="tl-pet-antenna-fx">
											<path className="tl-pet-stem-o" d="M0 4C-3-10 9-16 8-30" />
											<path className="tl-pet-stem" d="M0 4C-3-10 9-16 8-30" />
											<circle className="tl-pet-c-bobble tl-pet-ol" cx="8" cy="-35" r="7.5" />
											<circle className="tl-pet-c-shine" cx="5.8" cy="-37.4" r="2" />
										</g>
									</g>
								</g>
								<g transform="translate(61 69)">
									<g className="tl-pet-ear">
										<g className="tl-pet-ear-fx tl-pet-ear-fx-l">
											<path className="tl-pet-c-body tl-pet-ol" d="M-14 12L-11-21L15-2Z" />
											<path className="tl-pet-c-ear" d="M-8 4L-7-12L7-3Z" />
										</g>
									</g>
								</g>
								<g transform="translate(131 69) scale(-1 1)">
									<g className="tl-pet-ear">
										<g className="tl-pet-ear-fx tl-pet-ear-fx-r">
											<path className="tl-pet-c-body tl-pet-ol" d="M-14 12L-11-21L15-2Z" />
											<path className="tl-pet-c-ear" d="M-8 4L-7-12L7-3Z" />
										</g>
									</g>
								</g>
								<g transform="translate(78 150)">
									<g className="tl-pet-leg tl-pet-leg-l">
										<g className="tl-pet-leg-fx tl-pet-leg-fx-l">
											<rect
												className="tl-pet-c-limb tl-pet-ol"
												x="-6.5"
												y="-2"
												width="13"
												height="30"
												rx="6.5"
											/>
											<ellipse className="tl-pet-c-limb tl-pet-ol" cx="2" cy="31" rx="12" ry="7" />
										</g>
									</g>
								</g>
								<g transform="translate(114 150)">
									<g className="tl-pet-leg tl-pet-leg-r">
										<g className="tl-pet-leg-fx tl-pet-leg-fx-r">
											<rect
												className="tl-pet-c-limb tl-pet-ol"
												x="-6.5"
												y="-2"
												width="13"
												height="30"
												rx="6.5"
											/>
											<ellipse className="tl-pet-c-limb tl-pet-ol" cx="2" cy="31" rx="12" ry="7" />
										</g>
									</g>
								</g>

								<path className="tl-pet-c-shade tl-pet-ol tl-pet-ol-body" d={BODY} />
								<path className="tl-pet-c-body" d={BODY} transform="translate(4.7 4.8) scale(.92)" />
								<ellipse
									className="tl-pet-c-gloss"
									cx="68"
									cy="76"
									rx="11"
									ry="6"
									transform="rotate(-38 68 76)"
								/>
								<g transform="translate(0 -9)">
									<g className="tl-pet-belly">
										<ellipse className="tl-pet-c-belly" cx="96" cy="148" rx="30" ry="17" />
										<path className="tl-pet-c-glyph" d={GLYPH} transform="translate(76.8 127) scale(.6)" />
									</g>
								</g>

								<g transform="translate(0 -7)">
									<g className="tl-pet-face">
										<ellipse className="tl-pet-c-cheek" cx="61" cy="121" rx="8" ry="5.5" />
										<ellipse className="tl-pet-c-cheek" cx="131" cy="121" rx="8" ry="5.5" />

										<g className="tl-pet-brow tl-pet-brow-ask">
											<path className="tl-pet-ink-line" d="M69 90Q76 87 83 90" />
											<path className="tl-pet-ink-line" d="M109 85Q116 80 123 86" />
										</g>
										<g className="tl-pet-brow tl-pet-brow-sad">
											<path className="tl-pet-ink-line" d="M68 91L83 85" />
											<path className="tl-pet-ink-line" d="M109 85L124 91" />
										</g>
										<g className="tl-pet-brow tl-pet-brow-grim">
											<path className="tl-pet-ink-line" d="M68 87L84 91" />
											<path className="tl-pet-ink-line" d="M108 91L124 87" />
										</g>

										<g className="tl-pet-glasses tl-pet-prop">
											<circle className="tl-pet-c-lens tl-pet-rim" cx="76" cy="104" r="13.5" />
											<circle className="tl-pet-c-lens tl-pet-rim" cx="116" cy="104" r="13.5" />
											<path
												className="tl-pet-rim tl-pet-rim-line"
												d="M89 102Q96 98 103 102M62.5 102L56 99M129.5 102L136 99"
											/>
										</g>
										<g className="tl-pet-eyes">
											<g className="tl-pet-look">
												<g className="tl-pet-blink">
													<g className="tl-pet-eyeset tl-pet-e-open">
														<ellipse className="tl-pet-c-ink" cx="76" cy="104" rx="7" ry="9.5" />
														<ellipse className="tl-pet-c-ink" cx="116" cy="104" rx="7" ry="9.5" />
														<circle className="tl-pet-c-shine" cx="78.2" cy="100.4" r="2.6" />
														<circle className="tl-pet-c-shine" cx="118.2" cy="100.4" r="2.6" />
														<circle className="tl-pet-c-shine" cx="74.2" cy="108" r="1.2" />
														<circle className="tl-pet-c-shine" cx="114.2" cy="108" r="1.2" />
													</g>
													<g className="tl-pet-eyeset tl-pet-e-happy">
														<path
															className="tl-pet-ink-line tl-pet-ink-line-bold"
															d="M68.5 108Q76 95 83.5 108"
														/>
														<path
															className="tl-pet-ink-line tl-pet-ink-line-bold"
															d="M108.5 108Q116 95 123.5 108"
														/>
													</g>
													<g className="tl-pet-eyeset tl-pet-e-dizzy">
														<path
															className="tl-pet-ink-line tl-pet-ink-line-bold"
															d="M70 97L82 110M82 97L70 110"
														/>
														<path
															className="tl-pet-ink-line tl-pet-ink-line-bold"
															d="M110 97L122 110M122 97L110 110"
														/>
													</g>
													<g className="tl-pet-eyeset tl-pet-e-focus">
														<path className="tl-pet-c-ink" d="M68.5 102H83.5A7.5 9.5 0 0 1 68.5 102Z" />
														<path
															className="tl-pet-c-ink"
															d="M108.5 102H123.5A7.5 9.5 0 0 1 108.5 102Z"
														/>
														<circle className="tl-pet-c-shine" cx="78" cy="106" r="2.1" />
														<circle className="tl-pet-c-shine" cx="118" cy="106" r="2.1" />
													</g>
												</g>
											</g>
										</g>

										<g className="tl-pet-glasses tl-pet-prop">
											<path className="tl-pet-gleam" d="M68.5 97Q72 93 77.5 94M108.5 97Q112 93 117.5 94" />
										</g>

										<path
											className="tl-pet-mouth tl-pet-m-smile tl-pet-ink-line"
											d="M89 119Q92.5 125 96 119Q99.5 125 103 119"
										/>
										<g className="tl-pet-mouth tl-pet-m-cheer">
											<path
												className="tl-pet-c-ink"
												d="M85 117Q96 119 107 117Q105 133 96 133Q87 133 85 117Z"
											/>
											<ellipse className="tl-pet-c-cheek" cx="96" cy="128.5" rx="5" ry="3" />
										</g>
										<path
											className="tl-pet-mouth tl-pet-m-frown tl-pet-ink-line"
											d="M86 128Q91 121 96 126T106 126"
										/>
										<ellipse
											className="tl-pet-mouth tl-pet-m-o tl-pet-c-ink"
											cx="96"
											cy="124"
											rx="4"
											ry="5"
										/>
										<g className="tl-pet-mouth tl-pet-m-grit">
											<rect
												className="tl-pet-c-shine tl-pet-grit-box"
												x="88"
												y="119"
												width="16"
												height="9"
												rx="3"
											/>
											<path className="tl-pet-ink-line tl-pet-ink-line-thin" d="M94 119V128M99 119V128" />
										</g>
										<path
											className="tl-pet-mouth tl-pet-m-flat tl-pet-ink-line"
											d="M90 122Q96 124.5 102 122"
										/>
									</g>
								</g>

								<g transform="translate(0 -10)">
									<g className="tl-pet-book tl-pet-prop">
										<rect className="tl-pet-c-cover tl-pet-ol" x="55" y="128" width="82" height="44" rx="6" />
										<path
											className="tl-pet-c-paper tl-pet-page"
											d="M96 133Q80 128 61 132V166Q80 162 96 168Z"
										/>
										<path
											className="tl-pet-c-paper tl-pet-page"
											d="M96 133Q112 128 131 132V166Q112 162 96 168Z"
										/>
										<g className="tl-pet-text">
											<path className="tl-pet-text-line tl-pet-text-line-a" d="M67 140H90" />
											<path className="tl-pet-text-line tl-pet-text-line-b" d="M67 148H88" />
											<path className="tl-pet-text-line tl-pet-text-line-c" d="M67 156H85" />
											<path className="tl-pet-text-line tl-pet-text-line-a" d="M102 140H125" />
											<path className="tl-pet-text-line tl-pet-text-line-b" d="M102 148H122" />
											<path className="tl-pet-text-line tl-pet-text-line-c" d="M102 156H119" />
										</g>
									</g>
								</g>

								<g transform="translate(46 112)">
									<g className="tl-pet-arm tl-pet-arm-l">
										<g className="tl-pet-arm-fx tl-pet-arm-fx-l">
											<rect
												className="tl-pet-c-limb tl-pet-ol"
												x="-7.5"
												y="-5"
												width="15"
												height="36"
												rx="7.5"
											/>
										</g>
									</g>
								</g>
								<g transform="translate(146 112)">
									<g className="tl-pet-arm tl-pet-arm-r">
										<g className="tl-pet-arm-fx tl-pet-arm-fx-r">
											<g className="tl-pet-hammer tl-pet-prop">
												<rect
													className="tl-pet-c-wood tl-pet-ol-thin"
													x="-2.6"
													y="24"
													width="5.2"
													height="34"
													rx="2"
												/>
												<rect
													className="tl-pet-c-steel tl-pet-ol"
													x="-11"
													y="50"
													width="22"
													height="13"
													rx="3.5"
												/>
											</g>
											<rect
												className="tl-pet-c-limb tl-pet-ol"
												x="-7.5"
												y="-5"
												width="15"
												height="36"
												rx="7.5"
											/>
										</g>
									</g>
								</g>
							</g>
						</g>
					</g>

					<g className="tl-pet-anvil tl-pet-prop">
						<path
							className="tl-pet-c-block tl-pet-ol"
							d="M136 171H186Q185 180 178 180H172L175 188H149L152 180H144Q137 180 136 171Z"
						/>
					</g>
					<g className="tl-pet-sparks tl-pet-prop">
						<circle className="tl-pet-c-spark tl-pet-spark tl-pet-spark-1" cx="160" cy="170" r="2.6" />
						<circle className="tl-pet-c-spark tl-pet-spark tl-pet-spark-2" cx="160" cy="170" r="3" />
						<circle className="tl-pet-c-spark tl-pet-spark tl-pet-spark-3" cx="160" cy="170" r="2.4" />
						<circle className="tl-pet-c-spark tl-pet-spark tl-pet-spark-4" cx="160" cy="170" r="2" />
					</g>
				</g>

				<g className="tl-pet-bubble tl-pet-prop">
					<g className="tl-pet-bubble-fx">
						<rect className="tl-pet-c-paper tl-pet-ol" x="138" y="14" width="36" height="34" rx="11" />
						<path className="tl-pet-c-paper tl-pet-ol" d="M146 46L141 59L158 47Z" />
						<rect className="tl-pet-c-paper" x="144" y="40" width="18" height="8" />
						<path
							className="tl-pet-q"
							d="M148.5 27Q148.5 21 156 21Q163.5 21 163.5 27Q163.5 31.5 156 34Q155.5 35 155.5 37"
						/>
						<circle className="tl-pet-c-glyph" cx="155.5" cy="42" r="2.6" />
					</g>
				</g>

				<g className="tl-pet-wave-lines tl-pet-prop">
					<path className="tl-pet-wave-line tl-pet-wave-line-a" d="M171 78Q179 85 176 94" />
					<path className="tl-pet-wave-line tl-pet-wave-line-b" d="M177 72Q187 83 183 98" />
				</g>

				<g className="tl-pet-sparkles tl-pet-prop">
					<g transform="translate(26 66)">
						<path className="tl-pet-c-spark tl-pet-sparkle" d={SPARKLE} />
					</g>
					<g transform="translate(168 58)">
						<path className="tl-pet-c-spark tl-pet-sparkle tl-pet-sparkle-b" d={SPARKLE} />
					</g>
					<g transform="translate(20 124)">
						<path className="tl-pet-c-spark tl-pet-sparkle tl-pet-sparkle-c" d={SPARKLE} />
					</g>
					<g transform="translate(174 118)">
						<path className="tl-pet-c-spark tl-pet-sparkle tl-pet-sparkle-d" d={SPARKLE} />
					</g>
				</g>

				<g className="tl-pet-dizzy tl-pet-prop">
					<g transform="translate(96 36)">
						<g className="tl-pet-orbit tl-pet-orbit-a">
							<g className="tl-pet-orbit-y">
								<path className="tl-pet-c-spark tl-pet-star" d={SPARKLE} />
							</g>
						</g>
						<g className="tl-pet-orbit tl-pet-orbit-b">
							<g className="tl-pet-orbit-y tl-pet-orbit-y-b">
								<path className="tl-pet-c-spark tl-pet-star" d={SPARKLE} />
							</g>
						</g>
						<g className="tl-pet-orbit tl-pet-orbit-c">
							<g className="tl-pet-orbit-y tl-pet-orbit-y-c">
								<path className="tl-pet-c-spark tl-pet-star" d={SPARKLE} />
							</g>
						</g>
					</g>
				</g>
				<g className="tl-pet-sweat-wrap tl-pet-prop">
					<g transform="translate(142 78)">
						<path className="tl-pet-c-sweat tl-pet-ol-thin tl-pet-sweat" d="M0-8Q7 1 0 7Q-7 1 0-8Z" />
					</g>
				</g>
			</g>
		</svg>
	);
}
