/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-globals */

import { getPartsSplashColors } from './partsSplash.js';

(async function () {

	// Add a perf entry right from the top
	performance.mark('code/didStartRenderer');

	type ISandboxConfiguration = import('../../../base/parts/sandbox/common/sandboxTypes.js').ISandboxConfiguration;
	type ILoadResult<M, T extends ISandboxConfiguration> = import('../../../platform/window/electron-browser/window.js').ILoadResult<M, T>;
	type ILoadOptions<T extends ISandboxConfiguration> = import('../../../platform/window/electron-browser/window.js').ILoadOptions<T>;
	type INativeWindowConfiguration = import('../../../platform/window/common/window.ts').INativeWindowConfiguration;
	type IMainWindowSandboxGlobals = import('../../../base/parts/sandbox/electron-browser/globals.js').IMainWindowSandboxGlobals;
	type IDesktopMain = import('../../../workbench/electron-browser/desktop.main.js').IDesktopMain;
	type IPartsSplashPartBounds = import('../../../platform/theme/common/themeService.js').IPartsSplashPartBounds;

	const preloadGlobals = (window as unknown as { vscode: IMainWindowSandboxGlobals }).vscode; // defined by preload.ts
	const safeProcess = preloadGlobals.process;

	//#region Splash Screen Helpers

	function showSplash(configuration: INativeWindowConfiguration) {
		performance.mark('code/willShowPartsSplash');
		showDefaultSplash(configuration);
		showDragonSplash(configuration); // DRAGON: molten dragon loader over the parts splash
		performance.mark('code/didShowPartsSplash');
	}

	//#region DRAGON: doom-dragon splash (hidden by PartsSplash once the workbench has restored)

	function showDragonSplash(configuration: INativeWindowConfiguration) {
		// eslint-disable-next-line no-restricted-syntax
		let splash = window.document.getElementById('monaco-parts-splash');
		if (!splash) {
			// First launch has no saved layout, so there is no parts splash to draw on.
			splash = document.createElement('div');
			splash.id = 'monaco-parts-splash';
			window.document.body.appendChild(splash);
		}
		appendDragonDoomLoader(splash, configuration, configuration.partsSplash?.baseTheme);
	}

	function appendDragonDoomLoader(splash: HTMLElement, configuration: INativeWindowConfiguration, baseTheme: string | undefined): void {
		const logoUrl = new URL('vs/workbench/browser/parts/editor/media/dragon-mark.png', `${fileUriFromPath(configuration.appRoot, { isWindows: safeProcess.platform === 'win32', scheme: 'vscode-file', fallbackAuthority: 'vscode-app' })}/out/`).href;
		const highContrast = baseTheme === 'hc-black' || baseTheme === 'hc-light';
		splash.dataset.dragonDoomLoaderStartedAt = String(performance.now());

		const style = document.createElement('style');
		style.id = 'dragon-doom-loader-styles';
		style.textContent = `
				#monaco-parts-splash .dragon-doom-loader {
					position: fixed;
					inset: 0;
					z-index: 20;
					display: flex;
					align-items: center;
					justify-content: center;
					overflow: hidden;
					background:
						radial-gradient(circle at 50% 74%, rgba(255, 104, 0, 0.38) 0, rgba(112, 65, 24, 0.18) 22%, rgba(7, 0, 0, 0) 48%),
						radial-gradient(circle at 50% 52%, rgba(87, 58, 30, 0.32) 0, rgba(20, 17, 14, 0.92) 50%, #100e0c 100%);
					color: #f6d7a6;
					isolation: isolate;
					animation: dragonDoomIgnite 1200ms cubic-bezier(0.16, 1, 0.3, 1) both;
				}

				#monaco-parts-splash .dragon-doom-vignette,
				#monaco-parts-splash .dragon-doom-fire,
				#monaco-parts-splash .dragon-doom-smoke,
				#monaco-parts-splash .dragon-doom-shimmer {
					position: absolute;
					inset: -12%;
					pointer-events: none;
				}

				#monaco-parts-splash .dragon-doom-vignette {
					z-index: 4;
					background: radial-gradient(circle at center, rgba(0, 0, 0, 0) 18%, rgba(0, 0, 0, 0.42) 62%, rgba(0, 0, 0, 0.92) 100%);
				}

				#monaco-parts-splash .dragon-doom-fire {
					z-index: 1;
					background:
						radial-gradient(ellipse at 48% 98%, rgba(255, 185, 43, 0.68) 0, rgba(255, 143, 35, 0.42) 18%, rgba(74, 0, 0, 0) 54%),
						linear-gradient(0deg, rgba(245, 154, 69, 0.42), rgba(51, 35, 20, 0.16) 36%, rgba(0, 0, 0, 0) 64%);
					filter: blur(18px) saturate(1.7);
					transform-origin: 50% 100%;
					animation: dragonFirePulse 1800ms ease-in-out infinite alternate;
				}

				#monaco-parts-splash .dragon-doom-smoke {
					z-index: 2;
					background:
						radial-gradient(ellipse at 32% 70%, rgba(88, 59, 32, 0.28) 0, rgba(0, 0, 0, 0) 44%),
						radial-gradient(ellipse at 70% 62%, rgba(94, 20, 17, 14.24) 0, rgba(0, 0, 0, 0) 42%),
						repeating-linear-gradient(118deg, rgba(255, 104, 0, 0.07) 0 1px, rgba(0, 0, 0, 0) 1px 19px);
					filter: blur(20px);
					opacity: 0.72;
					animation: dragonHeatShimmer 2600ms ease-in-out infinite alternate;
				}

				#monaco-parts-splash .dragon-doom-shimmer {
					z-index: 5;
					background: linear-gradient(110deg, transparent 30%, rgba(255, 220, 146, 0.12) 46%, transparent 61%);
					mix-blend-mode: screen;
					opacity: 0;
					transform: translateX(-34%) skewX(-12deg);
					animation: dragonMoltenSweep 2100ms ease-in-out 500ms infinite;
				}

				#monaco-parts-splash .dragon-doom-mark {
					position: relative;
					z-index: 3;
					width: min(30vw, 320px, 62vh);
					aspect-ratio: 1;
					border-radius: 22%;
					background-image: url("${logoUrl}");
					background-position: center;
					background-repeat: no-repeat;
					background-size: contain;
					filter:
						brightness(0.72)
						contrast(1.35)
						drop-shadow(0 0 22px rgba(255, 153, 51, 0.92))
						drop-shadow(0 0 68px rgba(156, 90, 28, 0.72))
						drop-shadow(0 28px 34px rgba(0, 0, 0, 0.86));
					box-shadow:
						0 0 0 1px rgba(255, 190, 92, 0.16),
						0 0 42px rgba(245, 154, 69, 0.38),
						inset 0 0 48px rgba(255, 98, 0, 0.22),
						inset 0 -28px 64px rgba(0, 0, 0, 0.72);
					transform: translateY(18px) scale(0.84);
					opacity: 0;
					animation:
						dragonMoltenReveal 1050ms cubic-bezier(0.16, 1, 0.3, 1) 160ms forwards,
						dragonMetalPulse 1700ms ease-in-out 1100ms infinite alternate;
				}

				#monaco-parts-splash .dragon-doom-mark::after {
					content: '';
					position: absolute;
					inset: -24%;
					z-index: -1;
					border-radius: 32%;
					background: radial-gradient(circle, rgba(255, 115, 0, 0.42), rgba(136, 82, 28, 0.25) 35%, rgba(0, 0, 0, 0) 66%);
					filter: blur(22px);
					animation: dragonFirePulse 1400ms ease-in-out infinite alternate;
				}

				#monaco-parts-splash .dragon-doom-ember {
					position: absolute;
					z-index: 6;
					bottom: -8vh;
					width: var(--ember-size);
					height: var(--ember-size);
					left: var(--ember-left);
					border-radius: 999px;
					background: #ffb347;
					box-shadow: 0 0 12px #ffa33b, 0 0 28px rgba(245, 154, 69, 0.55);
					opacity: 0;
					transform: translate3d(0, 0, 0);
					animation: dragonEmberRise var(--ember-duration) linear var(--ember-delay) infinite;
				}

				#monaco-parts-splash .dragon-doom-title {
					position: absolute;
					z-index: 7;
					left: 0;
					right: 0;
					top: calc(50% + min(33vh, 210px));
					text-align: center;
					letter-spacing: 0.42em;
					text-transform: uppercase;
					font-size: 12px;
					font-weight: 700;
					color: rgba(255, 217, 168, 0.86);
					text-shadow: 0 0 12px rgba(245, 154, 69, 0.95), 0 0 34px rgba(145, 92, 34, 0.9);
					opacity: 0;
					animation: dragonDoomTitleReveal 900ms ease-out 520ms forwards;
				}

				#monaco-parts-splash .dragon-doom-dragon-stage {
					position: absolute;
					z-index: 6;
					left: 50%;
					top: calc(50% - min(16vh, 118px));
					width: min(760px, 92vw);
					height: min(280px, 34vh);
					transform: translateX(-50%) scale(0.7);
					transform-origin: center;
					pointer-events: none;
					opacity: 0.58;
					filter: drop-shadow(0 0 34px rgba(255, 121, 36, 0.36));
				}

				#monaco-parts-splash .dragon-doom-dragon-stage svg {
					width: 100%;
					height: 100%;
					overflow: visible;
				}

				#monaco-parts-splash .dragon-doom-dragon-path {
					fill: none;
					stroke: url(#dragon-doom-dragon-gradient);
					stroke-width: 18;
					stroke-linecap: round;
					stroke-linejoin: round;
					animation: dragonDragonSway 3200ms ease-in-out infinite alternate;
				}

				#monaco-parts-splash .dragon-doom-dragon-head {
					fill: #180706;
					stroke: #ffd58a;
					stroke-width: 7;
					filter: drop-shadow(0 0 18px rgba(255, 94, 30, 0.8));
					animation: dragonDragonSway 3200ms ease-in-out infinite alternate;
				}

				@keyframes dragonDoomIgnite {
					0% { background-color: #000; filter: saturate(0.8); }
					35% { background-color: #120000; filter: saturate(1.4); }
					100% { background-color: #050000; filter: saturate(1.1); }
				}

				@keyframes dragonMoltenReveal {
					0% { opacity: 0; transform: translateY(24px) scale(0.78); filter: brightness(0.1) contrast(1.8) drop-shadow(0 0 0 rgba(255, 153, 51, 0)); }
					45% { opacity: 1; transform: translateY(-3px) scale(1.06); filter: brightness(1.32) contrast(1.55) drop-shadow(0 0 48px rgba(255, 117, 0, 1)); }
					100% { opacity: 1; transform: translateY(0) scale(1); }
				}

				@keyframes dragonDoomTitleReveal {
					0% { opacity: 0; filter: brightness(0.2); }
					45% { opacity: 1; filter: brightness(1.35); }
					100% { opacity: 1; filter: brightness(1); }
				}

				@keyframes dragonFirePulse {
					0% { opacity: 0.56; transform: scale3d(0.96, 0.9, 1) translateY(2%); }
					100% { opacity: 0.94; transform: scale3d(1.08, 1.03, 1) translateY(-2%); }
				}

				@keyframes dragonMetalPulse {
					0% { filter: brightness(0.72) contrast(1.35) drop-shadow(0 0 18px rgba(255, 153, 51, 0.74)) drop-shadow(0 0 58px rgba(156, 90, 28, 0.62)) drop-shadow(0 28px 34px rgba(0, 0, 0, 0.86)); }
					100% { filter: brightness(0.92) contrast(1.48) drop-shadow(0 0 30px rgba(255, 104, 0, 0.98)) drop-shadow(0 0 82px rgba(190, 115, 39, 0.82)) drop-shadow(0 28px 34px rgba(0, 0, 0, 0.86)); }
				}

				@keyframes dragonEmberRise {
					0% { opacity: 0; transform: translate3d(0, 0, 0) scale(0.5); }
					12% { opacity: 0.95; }
					100% { opacity: 0; transform: translate3d(var(--ember-drift), -112vh, 0) scale(0.12); }
				}

				@keyframes dragonHeatShimmer {
					0% { transform: translate3d(-1.2%, 1.6%, 0) scale(1.03); opacity: 0.46; }
					100% { transform: translate3d(1.4%, -1.2%, 0) scale(1.08); opacity: 0.82; }
				}

				@keyframes dragonMoltenSweep {
					0%, 42% { opacity: 0; transform: translateX(-42%) skewX(-12deg); }
					52% { opacity: 0.9; }
					72%, 100% { opacity: 0; transform: translateX(42%) skewX(-12deg); }
				}

				@keyframes dragonDragonSway {
					0% { transform: translate3d(-18px, 8px, 0) rotate(-2deg); }
					100% { transform: translate3d(18px, -10px, 0) rotate(2deg); }
				}

				@keyframes dragonDragonSwayReduce {
					0% { transform: translate3d(-5px, 2px, 0) rotate(-0.6deg); }
					100% { transform: translate3d(5px, -2px, 0) rotate(0.6deg); }
				}

				#monaco-parts-splash .dragon-doom-loader.dragon-doom-loader-hc {
					background: #000;
					color: CanvasText;
				}

				#monaco-parts-splash .dragon-doom-loader.dragon-doom-loader-hc .dragon-doom-fire,
				#monaco-parts-splash .dragon-doom-loader.dragon-doom-loader-hc .dragon-doom-smoke,
				#monaco-parts-splash .dragon-doom-loader.dragon-doom-loader-hc .dragon-doom-shimmer,
				#monaco-parts-splash .dragon-doom-loader.dragon-doom-loader-hc .dragon-doom-ember {
					display: none;
				}

				#monaco-parts-splash .dragon-doom-loader.dragon-doom-loader-hc .dragon-doom-mark {
					filter: none;
					box-shadow: 0 0 0 2px CanvasText;
					animation: dragonMoltenReveal 500ms ease-out forwards;
				}

				@media (prefers-reduced-motion: reduce) {
					#monaco-parts-splash .dragon-doom-loader,
					#monaco-parts-splash .dragon-doom-fire,
					#monaco-parts-splash .dragon-doom-smoke,
					#monaco-parts-splash .dragon-doom-shimmer,
					#monaco-parts-splash .dragon-doom-mark,
					#monaco-parts-splash .dragon-doom-mark::after,
					#monaco-parts-splash .dragon-doom-ember,
					#monaco-parts-splash .dragon-doom-title {
						animation: none;
					}

					#monaco-parts-splash .dragon-doom-mark,
					#monaco-parts-splash .dragon-doom-title {
						opacity: 1;
					}

					#monaco-parts-splash .dragon-doom-mark {
						transform: none;
					}

					#monaco-parts-splash .dragon-doom-dragon-path,
					#monaco-parts-splash .dragon-doom-dragon-head {
						animation: dragonDragonSwayReduce 5200ms ease-in-out infinite alternate !important;
					}
				}
			`;
		window.document.head.appendChild(style);

		const loader = document.createElement('div');
		loader.className = highContrast ? 'dragon-doom-loader dragon-doom-loader-hc' : 'dragon-doom-loader';
		loader.setAttribute('aria-label', 'Dragon IDE is starting');

		for (const className of ['dragon-doom-fire', 'dragon-doom-smoke', 'dragon-doom-vignette', 'dragon-doom-shimmer']) {
			const layer = document.createElement('div');
			layer.className = className;
			loader.appendChild(layer);
		}

		const mark = document.createElement('div');
		mark.className = 'dragon-doom-mark';
		loader.appendChild(mark);

		const dragonStage = document.createElement('div');
		dragonStage.className = 'dragon-doom-dragon-stage';
		dragonStage.dataset.dragonSplashDragon = 'dragon-first-paint-reduce-motion-animated';
		const dragonSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		dragonSvg.setAttribute('viewBox', '0 0 840 280');
		dragonSvg.setAttribute('role', 'presentation');
		dragonSvg.setAttribute('focusable', 'false');
		const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
		const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
		gradient.id = 'dragon-doom-dragon-gradient';
		gradient.setAttribute('x1', '0');
		gradient.setAttribute('x2', '1');
		for (const [offset, color] of [['0', '#b76a24'], ['0.55', '#ffd58a'], ['1', '#302115']]) {
			const stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
			stop.setAttribute('offset', offset);
			stop.setAttribute('stop-color', color);
			gradient.appendChild(stop);
		}
		defs.appendChild(gradient);
		const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		body.classList.add('dragon-doom-dragon-path');
		body.setAttribute('d', 'M70 184 C160 54 292 54 392 174 S610 304 750 132');
		const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		head.classList.add('dragon-doom-dragon-head');
		head.setAttribute('d', 'M748 112 L810 136 L752 166 L770 140 Z');
		dragonSvg.append(defs, body, head);
		dragonStage.appendChild(dragonSvg);
		loader.appendChild(dragonStage);

		const title = document.createElement('div');
		title.className = 'dragon-doom-title';
		title.textContent = 'Dragon IDE';
		loader.appendChild(title);

		const emberSpecs = [
			[12, 2.4, 0, -18, 4], [18, 3.1, 0.18, 24, 3], [24, 2.7, 0.36, -36, 5], [31, 3.4, 0.54, 18, 2],
			[38, 2.5, 0.72, -24, 4], [45, 3.6, 0.9, 32, 3], [52, 2.8, 1.08, -14, 5], [59, 3.3, 1.26, 28, 2],
			[66, 2.6, 1.44, -30, 4], [73, 3.7, 1.62, 20, 3], [80, 2.9, 1.8, -22, 5], [87, 3.5, 1.98, 34, 2],
			[15, 3.8, 2.16, -42, 3], [34, 2.3, 2.34, 26, 4], [55, 4.1, 2.52, -28, 2], [76, 2.6, 2.7, 38, 5]
		];

		for (const [left, duration, delay, drift, size] of emberSpecs) {
			const ember = document.createElement('span');
			ember.className = 'dragon-doom-ember';
			ember.style.setProperty('--ember-left', `${left}%`);
			ember.style.setProperty('--ember-duration', `${duration}s`);
			ember.style.setProperty('--ember-delay', `${delay}s`);
			ember.style.setProperty('--ember-drift', `${drift}px`);
			ember.style.setProperty('--ember-size', `${size}px`);
			loader.appendChild(ember);
		}

		splash.appendChild(loader);
	}

	//#endregion

	function showDefaultSplash(configuration: INativeWindowConfiguration) {
		let data = configuration.partsSplash;
		if (data) {
			if (configuration.autoDetectHighContrast && configuration.colorScheme.highContrast) {
				if ((configuration.colorScheme.dark && data.baseTheme !== 'hc-black') || (!configuration.colorScheme.dark && data.baseTheme !== 'hc-light')) {
					data = undefined; // high contrast mode has been turned by the OS -> ignore stored colors and layouts
				}
			} else if (configuration.autoDetectColorScheme) {
				if ((configuration.colorScheme.dark && data.baseTheme !== 'vs-dark') || (!configuration.colorScheme.dark && data.baseTheme !== 'vs')) {
					data = undefined; // OS color scheme is tracked and has changed
				}
			}
		}

		// developing an extension -> ignore stored layouts
		if (data && configuration.extensionDevelopmentPath) {
			data.layoutInfo = undefined;
		}

		// minimal color configuration (works with or without persisted data)
		let baseTheme;
		let shellBackground;
		let shellForeground;
		const splashColors = data ? getPartsSplashColors(data, window.document.hasFocus(), !!configuration.workspace) : undefined;
		if (data) {
			baseTheme = data.baseTheme;
			shellBackground = splashColors?.background;
			shellForeground = data.colorInfo.foreground;
		} else if (configuration.autoDetectHighContrast && configuration.colorScheme.highContrast) {
			if (configuration.colorScheme.dark) {
				baseTheme = 'hc-black';
				shellBackground = '#000000';
				shellForeground = '#FFFFFF';
			} else {
				baseTheme = 'hc-light';
				shellBackground = '#FFFFFF';
				shellForeground = '#000000';
			}
		} else if (configuration.autoDetectColorScheme) {
			if (configuration.colorScheme.dark) {
				baseTheme = 'vs-dark';
				shellBackground = '#1E1E1E';
				shellForeground = '#CCCCCC';
			} else {
				baseTheme = 'vs';
				shellBackground = '#FFFFFF';
				shellForeground = '#000000';
			}
		}

		const style = document.createElement('style');
		style.className = 'initialShellColors';
		window.document.head.appendChild(style);
		style.textContent = `body {	background-color: ${shellBackground}; color: ${shellForeground}; margin: 0; padding: 0; }`;

		// set zoom level as soon as possible
		if (typeof data?.zoomLevel === 'number' && typeof preloadGlobals?.webFrame?.setZoomLevel === 'function') {
			preloadGlobals.webFrame.setZoomLevel(data.zoomLevel);
		}

		// restore parts if possible (we might not always store layout info)
		if (data?.layoutInfo) {
			const { layoutInfo, colorInfo } = data;
			const modernUI = layoutInfo.modernUI === true;
			const floatingMargin = layoutInfo.modernUICompact === true ? 0 : 4;
			// The cluster perimeter is the same in both densities; only the inter-card gap differs.
			const floatingOuterMargin = 4;
			const floatingBorderWidth = 1;
			const floatingBorderRadius = 8;
			const contentTop = layoutInfo.titleBarHeight;
			const contentBottom = layoutInfo.statusBarHeight;

			const splash = document.createElement('div');
			splash.id = 'monaco-parts-splash';
			splash.className = baseTheme ?? 'vs-dark';

			if (layoutInfo.windowBorder && colorInfo.windowBorder) {
				const borderElement = document.createElement('div');
				borderElement.style.position = 'absolute';
				borderElement.style.width = 'calc(100vw - 2px)';
				borderElement.style.height = 'calc(100vh - 2px)';
				borderElement.style.zIndex = '1'; // allow border above other elements
				borderElement.style.border = `1px solid var(--window-border-color)`;
				borderElement.style.setProperty('--window-border-color', colorInfo.windowBorder);

				if (layoutInfo.windowBorderRadius) {
					borderElement.style.borderRadius = layoutInfo.windowBorderRadius;
				}

				splash.appendChild(borderElement);
			}

			const setBounds = (element: HTMLElement, bounds: { top: number; bottom?: number; left?: number; right?: number; width?: number; height?: number }) => {
				element.style.position = 'absolute';
				element.style.top = `${bounds.top}px`;
				if (typeof bounds.bottom === 'number') {
					element.style.bottom = `${bounds.bottom}px`;
				}
				if (typeof bounds.left === 'number') {
					element.style.left = `${bounds.left}px`;
				}
				if (typeof bounds.right === 'number') {
					element.style.right = `${bounds.right}px`;
				}
				if (typeof bounds.width === 'number') {
					element.style.width = `${bounds.width}px`;
				}
				if (typeof bounds.height === 'number') {
					element.style.height = `${bounds.height}px`;
				}
			};

			const setPartBounds = (element: HTMLElement, bounds: { top: number; left: number; width: number; height: number }) => {
				element.style.position = 'absolute';
				element.style.top = `${bounds.top}px`;
				element.style.left = `${bounds.left}px`;
				element.style.width = `${bounds.width}px`;
				element.style.height = `${bounds.height}px`;
			};

			const fallbackActivityBarBounds: IPartsSplashPartBounds | undefined = layoutInfo.modernUICompact === true && layoutInfo.activityBarWidth > 0 ? {
				top: contentTop + (contentTop === 0 ? floatingOuterMargin : 0),
				left: layoutInfo.sideBarSide === 'left' ? floatingOuterMargin : window.innerWidth - layoutInfo.activityBarWidth,
				width: Math.max(0, layoutInfo.activityBarWidth - floatingOuterMargin),
				height: window.innerHeight - contentTop - contentBottom - floatingOuterMargin - (contentTop === 0 ? floatingOuterMargin : 0),
			} : undefined;
			const compactPartBounds = layoutInfo.modernUICompact === true ? [
				layoutInfo.partBounds?.activityBar,
				layoutInfo.partBounds?.sideBar,
				layoutInfo.partBounds?.auxiliaryBar,
				layoutInfo.partBounds?.editor,
				layoutInfo.partBounds?.panel,
			].filter((bounds): bounds is IPartsSplashPartBounds => !!bounds) : [];
			const compactHorizontalBounds = layoutInfo.modernUICompact === true ? [
				layoutInfo.partBounds?.activityBar ?? fallbackActivityBarBounds,
				layoutInfo.partBounds?.sideBar,
				layoutInfo.partBounds?.auxiliaryBar,
				layoutInfo.partBounds?.editor,
				layoutInfo.partBounds?.panel,
			].filter((bounds): bounds is IPartsSplashPartBounds => !!bounds) : [];
			const compactClusterEdges = compactPartBounds.length > 0 && compactHorizontalBounds.length > 0 ? {
				left: Math.min(...compactHorizontalBounds.map(bounds => bounds.left)),
				right: Math.max(...compactHorizontalBounds.map(bounds => bounds.left + bounds.width)),
				top: Math.min(...compactPartBounds.map(bounds => bounds.top)),
				bottom: Math.max(...compactPartBounds.map(bounds => bounds.top + bounds.height)),
			} : undefined;

			// Without saved `partBounds` (they are cleared whenever the resolved bar widths differ
			// from the ones stored for the workspace) the cluster edges cannot be measured, so
			// derive ownership from the fallback order instead: the outermost visible card on each
			// side owns that edge, and every card spans the content region vertically.
			const fallbackClusterOrder: readonly ('activityBar' | 'sideBar' | 'editor' | 'auxiliaryBar')[] = layoutInfo.sideBarSide === 'left'
				? ['activityBar', 'sideBar', 'editor', 'auxiliaryBar']
				: ['auxiliaryBar', 'editor', 'sideBar', 'activityBar'];
			const fallbackClusterVisible = {
				activityBar: layoutInfo.activityBarWidth > 0,
				sideBar: layoutInfo.sideBarWidth > 0,
				editor: true,
				auxiliaryBar: layoutInfo.auxiliaryBarWidth > 0,
			};
			const fallbackLeftOwner = fallbackClusterOrder.find(part => fallbackClusterVisible[part]);
			const fallbackRightOwner = [...fallbackClusterOrder].reverse().find(part => fallbackClusterVisible[part]);
			const fallbackOuterEdgesFor = (part: 'activityBar' | 'sideBar' | 'editor' | 'auxiliaryBar') => ({
				left: fallbackLeftOwner === part,
				right: fallbackRightOwner === part,
				top: true,
				bottom: true,
			});
			const fallbackInsetFor = (part: 'activityBar' | 'sideBar' | 'editor' | 'auxiliaryBar', edge: 'left' | 'right' | 'top' | 'bottom') =>
				modernUI ? fallbackOuterEdgesFor(part)[edge] ? floatingOuterMargin : floatingMargin : 0;

			const railBorderColor = colorInfo.modernActivityBarBorder ?? colorInfo.surfaceBorder ?? colorInfo.agentsPanelBorder ?? colorInfo.editorGroupBorder ?? 'transparent';

			const applyFloatingCardStyles = (
				element: HTMLElement,
				backgroundColor: string | undefined,
				partBounds?: IPartsSplashPartBounds,
				fallbackOuterEdges = { left: true, right: true, top: true, bottom: true },
				compactBorderColor = colorInfo.surfaceBorder ?? colorInfo.agentsPanelBorder ?? colorInfo.editorGroupBorder ?? 'transparent'
			) => {
				element.style.boxSizing = 'border-box';
				if (layoutInfo.modernUICompact === true) {
					const outerEdges = partBounds?.outerEdges ?? (partBounds && compactClusterEdges ? {
						left: partBounds.left === compactClusterEdges.left,
						right: partBounds.left + partBounds.width === compactClusterEdges.right,
						top: partBounds.top === compactClusterEdges.top,
						bottom: partBounds.top + partBounds.height === compactClusterEdges.bottom,
					} : fallbackOuterEdges);
					element.style.borderStyle = 'solid';
					element.style.borderColor = compactBorderColor;
					element.style.borderWidth = `${outerEdges.top ? floatingBorderWidth : 0}px ${floatingBorderWidth}px ${floatingBorderWidth}px ${outerEdges.left ? floatingBorderWidth : 0}px`;
					element.style.borderRadius = [
						outerEdges.top && outerEdges.left ? floatingBorderRadius : 0,
						outerEdges.top && outerEdges.right ? floatingBorderRadius : 0,
						outerEdges.bottom && outerEdges.right ? floatingBorderRadius : 0,
						outerEdges.bottom && outerEdges.left ? floatingBorderRadius : 0,
					].map(radius => `${radius}px`).join(' ');
				} else {
					element.style.border = `${floatingBorderWidth}px solid ${colorInfo.agentsPanelBorder ?? colorInfo.editorGroupBorder ?? 'transparent'}`;
					element.style.borderRadius = `${floatingBorderRadius}px`;
				}
				element.style.backgroundColor = backgroundColor ?? colorInfo.editorBackground ?? colorInfo.background;
				element.style.overflow = 'hidden';
			};

			const contentHeight = `calc(100% - ${contentTop + contentBottom}px)`;
			const activityHeight = modernUI ? `calc(100% - ${contentTop + contentBottom + floatingMargin}px)` : contentHeight;
			const modernActivityBarBackground = (window.document.hasFocus()
				? colorInfo.modernActivityBarBackground
				: colorInfo.modernActivityBarInactiveBackground ?? colorInfo.modernActivityBarBackground)
				?? colorInfo.activityBarBackground;

			if (layoutInfo.auxiliaryBarWidth === Number.MAX_SAFE_INTEGER) {
				// if auxiliary bar is maximized, it goes as wide as the
				// window width but leaving room for activity bar
				layoutInfo.auxiliaryBarWidth = window.innerWidth - layoutInfo.activityBarWidth;
			} else {
				// otherwise adjust for other parts sizes if not maximized
				layoutInfo.auxiliaryBarWidth = Math.min(layoutInfo.auxiliaryBarWidth, window.innerWidth - (layoutInfo.activityBarWidth + layoutInfo.editorPartMinWidth + layoutInfo.sideBarWidth));
			}
			layoutInfo.sideBarWidth = Math.min(layoutInfo.sideBarWidth, window.innerWidth - (layoutInfo.activityBarWidth + layoutInfo.editorPartMinWidth + layoutInfo.auxiliaryBarWidth));

			// part: title
			if (layoutInfo.titleBarHeight > 0) {
				const titleDiv = document.createElement('div');
				titleDiv.style.position = 'absolute';
				titleDiv.style.width = '100%';
				titleDiv.style.height = `${layoutInfo.titleBarHeight}px`;
				titleDiv.style.left = '0';
				titleDiv.style.top = '0';
				titleDiv.style.backgroundColor = splashColors?.titleBarBackground ?? '';
				(titleDiv.style as CSSStyleDeclaration & { '-webkit-app-region': string })['-webkit-app-region'] = 'drag';
				splash.appendChild(titleDiv);

				if (!modernUI && colorInfo.titleBarBorder) {
					const titleBorder = document.createElement('div');
					titleBorder.style.position = 'absolute';
					titleBorder.style.width = '100%';
					titleBorder.style.height = '1px';
					titleBorder.style.left = '0';
					titleBorder.style.bottom = '0';
					titleBorder.style.borderBottom = `1px solid ${colorInfo.titleBarBorder}`;
					titleDiv.appendChild(titleBorder);
				}
			}

			// part: activity bar
			if (layoutInfo.activityBarWidth > 0) {
				const activityDiv = document.createElement('div');
				const activityBarBounds = layoutInfo.partBounds?.activityBar;
				if (modernUI && activityBarBounds) {
					setPartBounds(activityDiv, activityBarBounds);
				} else if (layoutInfo.modernUICompact === true) {
					setBounds(activityDiv, {
						top: contentTop + (contentTop === 0 ? floatingOuterMargin : 0),
						bottom: contentBottom + floatingOuterMargin,
						...(layoutInfo.sideBarSide === 'left' ? { left: floatingOuterMargin } : { right: floatingOuterMargin }),
						width: Math.max(0, layoutInfo.activityBarWidth - floatingOuterMargin),
					});
				} else {
					activityDiv.style.position = 'absolute';
					activityDiv.style.width = `${layoutInfo.activityBarWidth}px`;
					activityDiv.style.height = activityHeight;
					activityDiv.style.top = `${contentTop}px`;
					if (layoutInfo.sideBarSide === 'left') {
						activityDiv.style.left = '0';
					} else {
						activityDiv.style.right = '0';
					}
				}
				if (layoutInfo.modernUICompact === true) {
					applyFloatingCardStyles(activityDiv, modernActivityBarBackground, activityBarBounds, fallbackOuterEdgesFor('activityBar'), railBorderColor);
				} else if (modernUI) {
					// The rail is a card here too: rounded on the window side, and square where it
					// meets the primary side bar so the two read as one connected surface.
					const radius = `${floatingBorderRadius}px`;
					activityDiv.style.boxSizing = 'border-box';
					activityDiv.style.backgroundColor = modernActivityBarBackground ?? 'transparent';
					activityDiv.style.border = `${floatingBorderWidth}px solid ${railBorderColor}`;
					activityDiv.style.borderRadius = layoutInfo.sideBarWidth === 0 ? radius
						: layoutInfo.sideBarSide === 'left' ? `${radius} 0 0 ${radius}` : `0 ${radius} ${radius} 0`;
					activityDiv.style.overflow = 'hidden';
				} else {
					activityDiv.style.backgroundColor = `${colorInfo.activityBarBackground}`;
				}
				splash.appendChild(activityDiv);

				if (!modernUI && colorInfo.activityBarBorder) {
					const activityBorderDiv = document.createElement('div');
					activityBorderDiv.style.position = 'absolute';
					activityBorderDiv.style.width = '1px';
					activityBorderDiv.style.height = '100%';
					activityBorderDiv.style.top = '0';
					if (layoutInfo.sideBarSide === 'left') {
						activityBorderDiv.style.right = '0';
						activityBorderDiv.style.borderRight = `1px solid ${colorInfo.activityBarBorder}`;
					} else {
						activityBorderDiv.style.left = '0';
						activityBorderDiv.style.borderLeft = `1px solid ${colorInfo.activityBarBorder}`;
					}
					activityDiv.appendChild(activityBorderDiv);
				}
			}

			// part: side bar
			if (layoutInfo.sideBarWidth > 0) {
				// The side bar meets the activity bar rail flush; with no rail it is the outermost
				// card on that edge and takes the cluster's outer gutter instead.
				const sideBarFallbackOuterEdges = fallbackOuterEdgesFor('sideBar');
				const sideBarClusterInset = modernUI && sideBarFallbackOuterEdges[layoutInfo.sideBarSide === 'left' ? 'left' : 'right'] ? floatingOuterMargin : 0;
				const sideDiv = document.createElement('div');
				if (modernUI && layoutInfo.partBounds?.sideBar) {
					setPartBounds(sideDiv, layoutInfo.partBounds.sideBar);
				} else if (layoutInfo.sideBarSide === 'left') {
					setBounds(sideDiv, {
						top: contentTop + (contentTop === 0 ? fallbackInsetFor('sideBar', 'top') : 0),
						bottom: contentBottom + fallbackInsetFor('sideBar', 'bottom'),
						left: layoutInfo.activityBarWidth + sideBarClusterInset,
						width: modernUI ? Math.max(0, layoutInfo.sideBarWidth - sideBarClusterInset - floatingBorderWidth * 2) : layoutInfo.sideBarWidth
					});
				} else {
					setBounds(sideDiv, {
						top: contentTop + (contentTop === 0 ? fallbackInsetFor('sideBar', 'top') : 0),
						bottom: contentBottom + fallbackInsetFor('sideBar', 'bottom'),
						right: layoutInfo.activityBarWidth + sideBarClusterInset,
						width: modernUI ? Math.max(0, layoutInfo.sideBarWidth - sideBarClusterInset - floatingBorderWidth * 2) : layoutInfo.sideBarWidth
					});
				}
				if (modernUI) {
					applyFloatingCardStyles(sideDiv, colorInfo.surfaceBackground ?? colorInfo.agentsPanelBackground ?? colorInfo.sideBarBackground, layoutInfo.partBounds?.sideBar, sideBarFallbackOuterEdges);
				} else {
					sideDiv.style.backgroundColor = `${colorInfo.sideBarBackground}`;
				}
				splash.appendChild(sideDiv);

				if (!modernUI && colorInfo.sideBarBorder) {
					const sideBorderDiv = document.createElement('div');
					sideBorderDiv.style.position = 'absolute';
					sideBorderDiv.style.width = '1px';
					sideBorderDiv.style.height = '100%';
					sideBorderDiv.style.top = '0';
					sideBorderDiv.style.right = '0';
					if (layoutInfo.sideBarSide === 'left') {
						sideBorderDiv.style.borderRight = `1px solid ${colorInfo.sideBarBorder}`;
					} else {
						sideBorderDiv.style.left = '0';
						sideBorderDiv.style.borderLeft = `1px solid ${colorInfo.sideBarBorder}`;
					}
					sideDiv.appendChild(sideBorderDiv);
				}
			}

			// part: auxiliary sidebar
			if (layoutInfo.auxiliaryBarWidth > 0) {
				const auxiliaryBarFallbackOuterEdges = fallbackOuterEdgesFor('auxiliaryBar');
				const auxSideDiv = document.createElement('div');
				if (modernUI && layoutInfo.partBounds?.auxiliaryBar) {
					setPartBounds(auxSideDiv, layoutInfo.partBounds.auxiliaryBar);
				} else if (layoutInfo.sideBarSide === 'left') {
					setBounds(auxSideDiv, {
						top: contentTop + (contentTop === 0 ? fallbackInsetFor('auxiliaryBar', 'top') : 0),
						bottom: contentBottom + fallbackInsetFor('auxiliaryBar', 'bottom'),
						right: fallbackInsetFor('auxiliaryBar', 'right'),
						width: modernUI ? Math.max(0, layoutInfo.auxiliaryBarWidth - fallbackInsetFor('auxiliaryBar', 'right') - floatingMargin - floatingBorderWidth * 2) : layoutInfo.auxiliaryBarWidth
					});
				} else {
					setBounds(auxSideDiv, {
						top: contentTop + (contentTop === 0 ? fallbackInsetFor('auxiliaryBar', 'top') : 0),
						bottom: contentBottom + fallbackInsetFor('auxiliaryBar', 'bottom'),
						left: fallbackInsetFor('auxiliaryBar', 'left'),
						width: modernUI ? Math.max(0, layoutInfo.auxiliaryBarWidth - fallbackInsetFor('auxiliaryBar', 'left') - floatingMargin - floatingBorderWidth * 2) : layoutInfo.auxiliaryBarWidth
					});
				}
				if (modernUI) {
					applyFloatingCardStyles(auxSideDiv, colorInfo.sideBarBackground, layoutInfo.partBounds?.auxiliaryBar, auxiliaryBarFallbackOuterEdges);
				} else {
					auxSideDiv.style.backgroundColor = `${colorInfo.sideBarBackground}`;
				}
				splash.appendChild(auxSideDiv);

				if (!modernUI && colorInfo.sideBarBorder) {
					const auxSideBorderDiv = document.createElement('div');
					auxSideBorderDiv.style.position = 'absolute';
					auxSideBorderDiv.style.width = '1px';
					auxSideBorderDiv.style.height = '100%';
					auxSideBorderDiv.style.top = '0';
					if (layoutInfo.sideBarSide === 'left') {
						auxSideBorderDiv.style.left = '0';
						auxSideBorderDiv.style.borderLeft = `1px solid ${colorInfo.sideBarBorder}`;
					} else {
						auxSideBorderDiv.style.right = '0';
						auxSideBorderDiv.style.borderRight = `1px solid ${colorInfo.sideBarBorder}`;
					}
					auxSideDiv.appendChild(auxSideBorderDiv);
				}
			}

			if (modernUI && (layoutInfo.partBounds?.editor || !layoutInfo.partBounds)) {
				const editorFallbackOuterEdges = fallbackOuterEdgesFor('editor');
				const editorDiv = document.createElement('div');
				if (layoutInfo.partBounds?.editor) {
					setPartBounds(editorDiv, layoutInfo.partBounds.editor);
				} else {
					const editorLeft = (layoutInfo.sideBarSide === 'left' ? layoutInfo.activityBarWidth + layoutInfo.sideBarWidth : layoutInfo.auxiliaryBarWidth) + fallbackInsetFor('editor', 'left');
					const editorRight = (layoutInfo.sideBarSide === 'left' ? layoutInfo.auxiliaryBarWidth : layoutInfo.activityBarWidth + layoutInfo.sideBarWidth) + fallbackInsetFor('editor', 'right');
					setBounds(editorDiv, {
						top: contentTop + (contentTop === 0 ? fallbackInsetFor('editor', 'top') : 0),
						bottom: contentBottom + fallbackInsetFor('editor', 'bottom'),
						left: editorLeft,
						right: editorRight
					});
				}
				applyFloatingCardStyles(editorDiv, colorInfo.editorBackground, layoutInfo.partBounds?.editor, editorFallbackOuterEdges, colorInfo.editorBorder ?? colorInfo.surfaceBorder ?? colorInfo.editorGroupBorder ?? 'transparent');
				splash.appendChild(editorDiv);
			}

			if (modernUI && layoutInfo.partBounds?.panel) {
				const panelDiv = document.createElement('div');
				setPartBounds(panelDiv, layoutInfo.partBounds.panel);
				applyFloatingCardStyles(panelDiv, colorInfo.panelBackground ?? colorInfo.editorBackground, layoutInfo.partBounds.panel);
				panelDiv.style.borderColor = colorInfo.modernPanelBorder ?? colorInfo.surfaceBorder ?? colorInfo.agentsPanelBorder ?? colorInfo.editorGroupBorder ?? 'transparent';
				splash.appendChild(panelDiv);
			}

			// part: statusbar
			if (layoutInfo.statusBarHeight > 0) {
				const statusDiv = document.createElement('div');
				statusDiv.style.position = 'absolute';
				statusDiv.style.width = '100%';
				statusDiv.style.height = `${layoutInfo.statusBarHeight}px`;
				statusDiv.style.bottom = '0';
				statusDiv.style.left = '0';
				statusDiv.style.backgroundColor = splashColors?.statusBarBackground ?? '';
				splash.appendChild(statusDiv);

				if (!modernUI && colorInfo.statusBarBorder) {
					const statusBorderDiv = document.createElement('div');
					statusBorderDiv.style.position = 'absolute';
					statusBorderDiv.style.width = '100%';
					statusBorderDiv.style.height = '1px';
					statusBorderDiv.style.top = '0';
					statusBorderDiv.style.borderTop = `1px solid ${colorInfo.statusBarBorder}`;
					statusDiv.appendChild(statusBorderDiv);
				}
			}

			window.document.body.appendChild(splash);
		}
	}

	//#endregion

	//#region Window Helpers

	async function load<M, T extends ISandboxConfiguration>(options: ILoadOptions<T>): Promise<ILoadResult<M, T>> {

		// Window Configuration from Preload Script
		const configuration = await resolveWindowConfiguration<T>();

		// Signal before import()
		options?.beforeImport?.(configuration);

		// Developer settings
		const { enableDeveloperKeybindings, removeDeveloperKeybindingsAfterLoad, developerDeveloperKeybindingsDisposable, forceDisableShowDevtoolsOnError } = setupDeveloperKeybindings(configuration, options);

		// NLS
		setupNLS<T>(configuration);

		// Compute base URL and set as global
		const baseUrl = new URL(`${fileUriFromPath(configuration.appRoot, { isWindows: safeProcess.platform === 'win32', scheme: 'vscode-file', fallbackAuthority: 'vscode-app' })}/out/`);
		globalThis._VSCODE_FILE_ROOT = baseUrl.toString();

		// Set product configuration as global (used e.g. to select the ASAR path in `amdX`)
		globalThis._VSCODE_PRODUCT_JSON = { ...configuration.product };

		// Dev only: CSS import map tricks
		setupCSSImportMaps<T>(configuration, baseUrl);

		// ESM Import
		try {
			let workbenchUrl: string;
			if (!!safeProcess.env['VSCODE_DEV'] && globalThis._VSCODE_USE_RELATIVE_IMPORTS) {
				workbenchUrl = '../../../workbench/workbench.desktop.main.js'; // for dev purposes only
			} else {
				workbenchUrl = new URL(`vs/workbench/workbench.desktop.main.js`, baseUrl).href;
			}

			const result = await import(workbenchUrl);
			if (developerDeveloperKeybindingsDisposable && removeDeveloperKeybindingsAfterLoad) {
				developerDeveloperKeybindingsDisposable();
			}

			return { result, configuration };
		} catch (error) {
			onUnexpectedError(error, enableDeveloperKeybindings && !forceDisableShowDevtoolsOnError);

			throw error;
		}
	}

	async function resolveWindowConfiguration<T extends ISandboxConfiguration>() {
		const timeout = setTimeout(() => { console.error(`[resolve window config] Could not resolve window configuration within 10 seconds, but will continue to wait...`); }, 10000);
		performance.mark('code/willWaitForWindowConfig');

		const configuration = await preloadGlobals.context.resolveConfiguration() as T;
		performance.mark('code/didWaitForWindowConfig');

		clearTimeout(timeout);

		return configuration;
	}

	function setupDeveloperKeybindings<T extends ISandboxConfiguration>(configuration: T, options: ILoadOptions<T>) {
		const {
			forceEnableDeveloperKeybindings,
			disallowReloadKeybinding,
			removeDeveloperKeybindingsAfterLoad,
			forceDisableShowDevtoolsOnError
		} = typeof options?.configureDeveloperSettings === 'function' ? options.configureDeveloperSettings(configuration) : {
			forceEnableDeveloperKeybindings: false,
			disallowReloadKeybinding: false,
			removeDeveloperKeybindingsAfterLoad: false,
			forceDisableShowDevtoolsOnError: false
		};

		const isDev = !!safeProcess.env['VSCODE_DEV'];
		const enableDeveloperKeybindings = Boolean(isDev || forceEnableDeveloperKeybindings);
		let developerDeveloperKeybindingsDisposable: Function | undefined = undefined;
		if (enableDeveloperKeybindings) {
			developerDeveloperKeybindingsDisposable = registerDeveloperKeybindings(disallowReloadKeybinding);
		}

		return {
			enableDeveloperKeybindings,
			removeDeveloperKeybindingsAfterLoad,
			developerDeveloperKeybindingsDisposable,
			forceDisableShowDevtoolsOnError
		};
	}

	function registerDeveloperKeybindings(disallowReloadKeybinding: boolean | undefined): Function {
		const ipcRenderer = preloadGlobals.ipcRenderer;

		const extractKey =
			function (e: KeyboardEvent) {
				return [
					e.ctrlKey ? 'ctrl-' : '',
					e.metaKey ? 'meta-' : '',
					e.altKey ? 'alt-' : '',
					e.shiftKey ? 'shift-' : '',
					e.keyCode
				].join('');
			};

		// Devtools & reload support
		const TOGGLE_DEV_TOOLS_KB = (safeProcess.platform === 'darwin' ? 'meta-alt-73' : 'ctrl-shift-73'); // mac: Cmd-Alt-I, rest: Ctrl-Shift-I
		const TOGGLE_DEV_TOOLS_KB_ALT = '123'; // F12
		const RELOAD_KB = (safeProcess.platform === 'darwin' ? 'meta-82' : 'ctrl-82'); // mac: Cmd-R, rest: Ctrl-R

		let listener: ((e: KeyboardEvent) => void) | undefined = function (e) {
			const key = extractKey(e);
			if (key === TOGGLE_DEV_TOOLS_KB || key === TOGGLE_DEV_TOOLS_KB_ALT) {
				ipcRenderer.send('vscode:toggleDevTools');
			} else if (key === RELOAD_KB && !disallowReloadKeybinding) {
				ipcRenderer.send('vscode:reloadWindow');
			}
		};

		window.addEventListener('keydown', listener);

		return function () {
			if (listener) {
				window.removeEventListener('keydown', listener);
				listener = undefined;
			}
		};
	}

	function setupNLS<T extends ISandboxConfiguration>(configuration: T): void {
		globalThis._VSCODE_NLS_MESSAGES = configuration.nls.messages;
		globalThis._VSCODE_NLS_LANGUAGE = configuration.nls.language;

		let language = configuration.nls.language || 'en';
		if (language === 'zh-tw') {
			language = 'zh-Hant';
		} else if (language === 'zh-cn') {
			language = 'zh-Hans';
		}

		window.document.documentElement.setAttribute('lang', language);
	}

	function onUnexpectedError(error: string | Error, showDevtoolsOnError: boolean): void {
		if (showDevtoolsOnError) {
			const ipcRenderer = preloadGlobals.ipcRenderer;
			ipcRenderer.send('vscode:openDevTools');
		}

		console.error(`[uncaught exception]: ${error}`);

		if (error && typeof error !== 'string' && error.stack) {
			console.error(error.stack);
		}
	}

	function fileUriFromPath(path: string, config: { isWindows?: boolean; scheme?: string; fallbackAuthority?: string }): string {

		// Since we are building a URI, we normalize any backslash
		// to slashes and we ensure that the path begins with a '/'.
		let pathName = path.replace(/\\/g, '/');
		if (pathName.length > 0 && pathName.charAt(0) !== '/') {
			pathName = `/${pathName}`;
		}

		let uri: string;

		// Windows: in order to support UNC paths (which start with '//')
		// that have their own authority, we do not use the provided authority
		// but rather preserve it.
		if (config.isWindows && pathName.startsWith('//')) {
			uri = encodeURI(`${config.scheme || 'file'}:${pathName}`);
		}

		// Otherwise we optionally add the provided authority if specified
		else {
			uri = encodeURI(`${config.scheme || 'file'}://${config.fallbackAuthority || ''}${pathName}`);
		}

		return uri.replace(/#/g, '%23');
	}

	function setupCSSImportMaps<T extends ISandboxConfiguration>(configuration: T, baseUrl: URL) {

		// DEV ---------------------------------------------------------------------------------------
		// DEV: This is for development and enables loading CSS via import-statements via import-maps.
		// DEV: For each CSS modules that we have we defined an entry in the import map that maps to
		// DEV: a blob URL that loads the CSS via a dynamic @import-rule.
		// DEV ---------------------------------------------------------------------------------------

		if (globalThis._VSCODE_DISABLE_CSS_IMPORT_MAP) {
			return; // disabled in certain development setups
		}

		if (Array.isArray(configuration.cssModules) && configuration.cssModules.length > 0) {
			performance.mark('code/willAddCssLoader');

			globalThis._VSCODE_CSS_LOAD = function (url) {
				const link = document.createElement('link');
				link.setAttribute('rel', 'stylesheet');
				link.setAttribute('type', 'text/css');
				link.setAttribute('href', url);

				window.document.head.appendChild(link);
			};

			const importMap: { imports: Record<string, string> } = { imports: {} };
			for (const cssModule of configuration.cssModules) {
				const cssUrl = new URL(cssModule, baseUrl).href;
				const jsSrc = `globalThis._VSCODE_CSS_LOAD('${cssUrl}');\n`;
				const blob = new Blob([jsSrc], { type: 'application/javascript' });
				importMap.imports[cssUrl] = URL.createObjectURL(blob);
			}

			const ttp = window.trustedTypes?.createPolicy('vscode-bootstrapImportMap', { createScript(value) { return value; }, });
			const importMapSrc = JSON.stringify(importMap, undefined, 2);
			const importMapScript = document.createElement('script');
			importMapScript.type = 'importmap';
			importMapScript.setAttribute('nonce', '0c6a828f1297');
			// @ts-expect-error
			importMapScript.textContent = ttp?.createScript(importMapSrc) ?? importMapSrc;
			window.document.head.appendChild(importMapScript);

			performance.mark('code/didAddCssLoader');
		}
	}

	//#endregion

	const { result, configuration } = await load<IDesktopMain, INativeWindowConfiguration>(
		{
			configureDeveloperSettings: function (windowConfig) {
				return {
					// disable automated devtools opening on error when running extension tests
					// as this can lead to nondeterministic test execution (devtools steals focus)
					forceDisableShowDevtoolsOnError: typeof windowConfig.extensionTestsPath === 'string' || windowConfig['enable-smoke-test-driver'] === true,
					// enable devtools keybindings in extension development window
					forceEnableDeveloperKeybindings: Array.isArray(windowConfig.extensionDevelopmentPath) && windowConfig.extensionDevelopmentPath.length > 0,
					removeDeveloperKeybindingsAfterLoad: true
				};
			},
			beforeImport: function (windowConfig) {

				// Show our splash as early as possible
				showSplash(windowConfig);

				// Code windows have a `vscodeWindowId` property to identify them
				Object.defineProperty(window, 'vscodeWindowId', {
					get: () => windowConfig.windowId
				});

				// It looks like browsers only lazily enable
				// the <canvas> element when needed. Since we
				// leverage canvas elements in our code in many
				// locations, we try to help the browser to
				// initialize canvas when it is idle, right
				// before we wait for the scripts to be loaded.
				window.requestIdleCallback(() => {
					const canvas = document.createElement('canvas');
					const context = canvas.getContext('2d');
					context?.clearRect(0, 0, canvas.width, canvas.height);
					canvas.remove();
				}, { timeout: 50 });

				// Track import() perf
				performance.mark('code/willLoadWorkbenchMain');
			}
		}
	);

	// Mark start of workbench
	performance.mark('code/didLoadWorkbenchMain');

	// Load workbench
	result.main(configuration);
}());
