/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The dragon that follows the pointer on the Dragon onboarding screen.
 *
 * A 24-segment dragon (head, body scales, two pairs of wings, tail) seen from above, drawn in a
 * full-screen `<svg>` from the shapes in dragonPaths.ts. The head steers toward the pointer
 * like a damped spring, with a slight serpentine sway; when the pointer rests it wanders a
 * figure-eight around the screen. Every other segment trails the one ahead at a fixed distance
 * and turns to face it, and the wings beat faster as the dragon speeds up.
 *
 * With prefers-reduced-motion the dragon starts from a still pose and moves at a third of the
 * speed, so the screen stays visibly alive without sweeping motion.
 *
 * Returns the stage `<div>` and a cleanup callback, which the caller invokes exactly once when
 * the stage is removed. Owns no commands, contributions, or shared state.
 */

import { mainWindow } from '../../../../base/browser/window.js';
import { DRAGON_PATHS, DRAGON_SEGMENT_COUNT, DRAGON_SVG_NS, DRAGON_WING_SEGMENTS } from './dragonPaths.js';

interface IDragonAnimationHandle {
	readonly stage: HTMLElement;
	readonly cleanup: () => void;
}

interface IPoint {
	x: number;
	y: number;
}

const HEAD_SCALE = 3.3;
const TAIL_SCALE = 0.95;
/** Distance between neighbouring segments, in segment units (multiplied by the segment's scale). */
const SEGMENT_SPACING = 10.5;
const HEAD_SPACING = 15;
/** How long after the last pointer move the dragon keeps chasing the pointer, in ms. */
const POINTER_ATTENTION_MS = 2600;

export function createDragonAnimation(doc: Document): IDragonAnimationHandle {
	const svgElement = <K extends keyof SVGElementTagNameMap>(tagName: K, attributes: Record<string, string> = {}): SVGElementTagNameMap[K] => {
		const element = doc.createElementNS(DRAGON_SVG_NS, tagName);
		for (const [name, value] of Object.entries(attributes)) {
			element.setAttribute(name, value);
		}
		return element;
	};
	const shape = (id: string, parts: ReadonlyArray<{ d: string; className: string; fill?: string }>): SVGGElement => {
		const group = svgElement('g', { id });
		for (const part of parts) {
			const path = svgElement('path', { d: part.d });
			path.classList.add(part.className);
			if (part.fill) {
				path.setAttribute('fill', part.fill);
			}
			group.appendChild(path);
		}
		return group;
	};
	const gradient = (tagName: 'linearGradient' | 'radialGradient', id: string, attributes: Record<string, string>, startClass: string, endClass: string): SVGElement => {
		const element = svgElement(tagName, { id, ...attributes });
		for (const [offset, className] of [['0', startClass], ['1', endClass]]) {
			const stop = svgElement('stop', { offset });
			stop.classList.add(className);
			element.appendChild(stop);
		}
		return element;
	};

	const stage = doc.createElement('div');
	stage.className = 'dragon-onboarding-dragon-stage';
	stage.setAttribute('aria-hidden', 'true');
	stage.dataset.dragonOnboardingDragon = 'dragon-only-no-background-scale-70';

	const svg = svgElement('svg', { role: 'presentation', focusable: 'false' });
	svg.classList.add('dragon-onboarding-dragon-svg');

	const ids = {
		head: 'dragon-onboarding-dragon-head',
		segment: 'dragon-onboarding-dragon-segment',
		wings: 'dragon-onboarding-dragon-wings',
		tail: 'dragon-onboarding-dragon-tail',
		bodyGradient: 'dragon-onboarding-dragon-body-gradient',
		wingGradient: 'dragon-onboarding-dragon-wing-gradient',
	};
	const defs = svgElement('defs');
	defs.append(
		// Scales are light at the front edge and darken toward the back.
		gradient('linearGradient', ids.bodyGradient, { x1: '1', y1: '0', x2: '0', y2: '0' }, 'dragon-onboarding-dragon-spine-start', 'dragon-onboarding-dragon-spine-end'),
		// Wings glow at the shoulder and darken toward the tips.
		gradient('radialGradient', ids.wingGradient, { cx: '0.7', cy: '0.5', r: '0.75' }, 'dragon-onboarding-dragon-fin-start', 'dragon-onboarding-dragon-fin-end'),
		shape(ids.head, [
			{ d: DRAGON_PATHS.head, className: 'dragon-onboarding-dragon-spine-path', fill: `url(#${ids.bodyGradient})` },
			{ d: DRAGON_PATHS.headDetail, className: 'dragon-onboarding-dragon-head-core' },
			{ d: DRAGON_PATHS.headHighlight, className: 'dragon-onboarding-dragon-head-highlight' },
		]),
		shape(ids.segment, [
			{ d: DRAGON_PATHS.segment, className: 'dragon-onboarding-dragon-spine-path', fill: `url(#${ids.bodyGradient})` },
			{ d: DRAGON_PATHS.segmentRidge, className: 'dragon-onboarding-dragon-ridge' },
		]),
		shape(ids.wings, [
			{ d: DRAGON_PATHS.wings, className: 'dragon-onboarding-dragon-fin-path', fill: `url(#${ids.wingGradient})` },
			{ d: DRAGON_PATHS.wingBones, className: 'dragon-onboarding-dragon-head-core' },
		]),
		shape(ids.tail, [
			{ d: DRAGON_PATHS.tail, className: 'dragon-onboarding-dragon-spine-path', fill: `url(#${ids.bodyGradient})` },
		]),
	);

	// Wings go underneath the body, and each segment is drawn over the one behind it.
	const wingLayer = svgElement('g');
	const bodyLayer = svgElement('g');
	svg.append(defs, wingLayer, bodyLayer);
	stage.appendChild(svg);

	const use = (layer: SVGGElement, id: string): SVGUseElement => {
		const element = svgElement('use', { href: `#${id}` });
		layer.prepend(element);
		return element;
	};
	const scales: number[] = [];
	const spacing: number[] = [];
	const bodies: SVGUseElement[] = [];
	const wings = new Map<number, SVGUseElement>();
	for (let i = 0; i < DRAGON_SEGMENT_COUNT; i++) {
		scales[i] = HEAD_SCALE + (TAIL_SCALE - HEAD_SCALE) * Math.pow(i / (DRAGON_SEGMENT_COUNT - 1), 0.9);
		spacing[i] = i === 1 ? HEAD_SPACING * scales[0] : SEGMENT_SPACING * scales[i];
		bodies[i] = use(bodyLayer, i === 0 ? ids.head : i === DRAGON_SEGMENT_COUNT - 1 ? ids.tail : ids.segment);
		if (DRAGON_WING_SEGMENTS.has(i)) {
			wings.set(i, use(wingLayer, ids.wings));
		}
	}

	const reduceMotion = mainWindow.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
	const speed = reduceMotion ? 0.34 : 1;
	let width = 1000;
	let height = 620;
	const updateBounds = (): void => {
		width = Math.max(stage.clientWidth || mainWindow.innerWidth, 320);
		height = Math.max(stage.clientHeight || mainWindow.innerHeight, 320);
		svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
	};
	updateBounds();

	// Start stretched out to the left of the centre, facing right.
	const points: IPoint[] = [];
	let x = width / 2;
	for (let i = 0; i < DRAGON_SEGMENT_COUNT; i++) {
		x -= i ? spacing[i] : 0;
		points.push({ x, y: height / 2 + Math.sin(i / 3) * 18 });
	}
	const velocity = { x: 0, y: 0 };
	const pointer = { x: width / 2, y: height / 2, movedAt: -Infinity };
	let clock = Math.random() * 100;
	let flap = 0;

	const render = (): void => {
		for (let i = 0; i < DRAGON_SEGMENT_COUNT; i++) {
			const point = points[i];
			const ahead = i === 0 ? { x: 2 * points[0].x - points[1].x, y: 2 * points[0].y - points[1].y } : points[i - 1];
			const angle = Math.atan2(ahead.y - point.y, ahead.x - point.x) * 180 / Math.PI;
			const s = scales[i];
			const place = `translate(${point.x.toFixed(1)},${point.y.toFixed(1)}) rotate(${angle.toFixed(1)})`;
			bodies[i].setAttribute('transform', `${place} scale(${s.toFixed(3)})`);
			const wing = wings.get(i);
			if (wing) {
				// A beat folds the wings in toward the body and opens them out again.
				const beat = Math.sin(flap + i * 0.9);
				wing.setAttribute('transform', `${place} scale(${(s * (1 + 0.06 * beat)).toFixed(3)},${(s * (0.86 + 0.2 * beat)).toFixed(3)})`);
			}
		}
	};

	const step = (seconds: number): void => {
		clock += seconds;
		const head = points[0];
		let target: IPoint;
		if (performance.now() - pointer.movedAt < POINTER_ATTENTION_MS) {
			target = pointer;
		} else {
			// Wander a slow figure-eight around the centre of the screen.
			target = {
				x: width / 2 + Math.cos(clock * 0.37) * width * 0.3,
				y: height / 2 + Math.sin(clock * 0.74) * height * 0.26,
			};
		}
		// Sway sideways, across the direction of travel, like a swimming serpent.
		const travel = Math.hypot(velocity.x, velocity.y) || 1;
		const sway = Math.sin(clock * 3.1) * 26;
		const tx = target.x - velocity.y / travel * sway;
		const ty = target.y + velocity.x / travel * sway;

		// The head is a damped spring pulled toward the target, with a top speed.
		const stiffness = 7 * speed * speed;
		const damping = 3.4 * speed;
		velocity.x += ((tx - head.x) * stiffness - velocity.x * damping) * seconds;
		velocity.y += ((ty - head.y) * stiffness - velocity.y * damping) * seconds;
		const maxSpeed = 1100 * speed;
		const currentSpeed = Math.hypot(velocity.x, velocity.y);
		if (currentSpeed > maxSpeed) {
			velocity.x *= maxSpeed / currentSpeed;
			velocity.y *= maxSpeed / currentSpeed;
		}
		head.x += velocity.x * seconds;
		head.y += velocity.y * seconds;

		// Each segment keeps its distance from the one ahead, pulled along the line between them.
		for (let i = 1; i < DRAGON_SEGMENT_COUNT; i++) {
			const ahead = points[i - 1];
			const point = points[i];
			const dx = point.x - ahead.x;
			const dy = point.y - ahead.y;
			const distance = Math.hypot(dx, dy) || 1;
			point.x = ahead.x + dx / distance * spacing[i];
			point.y = ahead.y + dy / distance * spacing[i];
		}
		flap += seconds * (4 + Math.min(currentSpeed, 900) / 90) * speed;
	};

	let frame = 0;
	let last = 0;
	const run = (now: number): void => {
		// Cap the step so a background tab does not make the dragon jump when it returns.
		const seconds = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
		last = now;
		step(seconds);
		render();
		frame = mainWindow.requestAnimationFrame(run);
	};

	const onPointerMove = (event: PointerEvent): void => {
		const rect = stage.getBoundingClientRect();
		pointer.x = (event.clientX - rect.left) * width / Math.max(rect.width, 1);
		pointer.y = (event.clientY - rect.top) * height / Math.max(rect.height, 1);
		pointer.movedAt = performance.now();
	};
	mainWindow.addEventListener('pointermove', onPointerMove, { passive: true });

	let resizeObserver: ResizeObserver | undefined;
	if (typeof mainWindow.ResizeObserver === 'function') {
		resizeObserver = new mainWindow.ResizeObserver(updateBounds);
		resizeObserver.observe(stage);
	}

	render();
	frame = mainWindow.requestAnimationFrame(run);

	const cleanup = (): void => {
		mainWindow.removeEventListener('pointermove', onPointerMove);
		resizeObserver?.disconnect();
		if (frame) {
			mainWindow.cancelAnimationFrame(frame);
			frame = 0;
		}
	};

	return { stage, cleanup };
}
