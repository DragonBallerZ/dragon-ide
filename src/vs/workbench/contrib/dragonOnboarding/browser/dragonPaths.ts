/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const DRAGON_SVG_NS = 'http://www.w3.org/2000/svg';
export const DRAGON_SEGMENT_COUNT = 24;

/** Segments (counted from the head, which is 0) that carry a pair of wings. */
export const DRAGON_WING_SEGMENTS: ReadonlySet<number> = new Set([4, 11]);

/*
 * Original artwork for Dragon IDE, drawn for this repository and released under its MIT license.
 * The dragon is seen from above. Every shape faces +x (the direction of travel) and is symmetric
 * about y = 0, so a segment is placed with one translate, rotate and scale.
 */
export const DRAGON_PATHS = {
	/** Head silhouette: snout, cheeks, brow and two horns swept back. */
	head: 'M24,0Q23.5,-3.2 19.5,-4.6Q14,-5.6 9.5,-8.2Q5,-11.8 -1,-12.2L-7,-13.8L-27,-24Q-19,-15.5 -13.5,-9.4L-19,-10.4L-15,-5.6Q-17.5,-3.8 -19,-2L-19,2Q-17.5,3.8 -15,5.6L-19,10.4L-13.5,9.4Q-19,15.5 -27,24L-7,13.8L-1,12.2Q5,11.8 9.5,8.2Q14,5.6 19.5,4.6Q23.5,3.2 24,0Z',
	/** Horns, eyes, nostrils and the ridge down the skull, drawn dark over the head. */
	headDetail: 'M-7,-13.8L-27,-24Q-19,-15.5 -13.5,-9.4L-4,-11.2ZM-7,13.8L-27,24Q-19,15.5 -13.5,9.4L-4,11.2ZM0,-7.4Q5.5,-10.6 11,-7.4Q5.4,-5.4 0,-7.4ZM0,7.4Q5.5,10.6 11,7.4Q5.4,5.4 0,7.4ZM18,-2.9Q20.4,-3.2 21.6,-2Q19.8,-1.7 18,-2.9ZM18,2.9Q20.4,3.2 21.6,2Q19.8,1.7 18,2.9ZM14,0L4,-1.4L-14,0L4,1.4Z',
	/** The glint in each eye. */
	headHighlight: 'M6,-8Q7.6,-8.9 8.8,-7.9Q7.3,-7.2 6,-8ZM6,8Q7.6,8.9 8.8,7.9Q7.3,7.2 6,8Z',
	/** One body scale with a spike on each side. */
	segment: 'M8,0Q7.4,-6.4 1.5,-8.6L-6,-15.5Q-3.8,-9 -6.5,-5.4Q-8.5,-2.4 -8.5,0Q-8.5,2.4 -6.5,5.4Q-3.8,9 -6,15.5L1.5,8.6Q7.4,6.4 8,0Z',
	/** The dorsal plate on top of each scale. */
	segmentRidge: 'M5,0L-1,-2.4L-7,0L-1,2.4Z',
	/** A pair of bat wings, the membrane scalloped between four fingers. */
	wings: 'M4,-5Q10,-24 3,-46Q-2,-54 -8,-58Q-9,-49 -14,-44Q-15,-37 -21,-33Q-19,-25 -22,-20Q-15,-15 -9,-6Q-4,-4 4,-5ZM4,5Q10,24 3,46Q-2,54 -8,58Q-9,49 -14,44Q-15,37 -21,33Q-19,25 -22,20Q-15,15 -9,6Q-4,4 4,5Z',
	/** The wing bones: the arm and three fingers of each wing. */
	wingBones: 'M4,-5Q9.5,-24 3,-46L-8,-58L1.6,-44.6Q6.5,-26 2,-7ZM1.2,-30L-14,-44L-13,-42.6L0.5,-27.6ZM0,-18L-21,-33L-20.2,-31.6L-0.8,-16ZM4,5Q9.5,24 3,46L-8,58L1.6,44.6Q6.5,26 2,7ZM1.2,30L-14,44L-13,42.6L0.5,27.6ZM0,18L-21,33L-20.2,31.6L-0.8,16Z',
	/** The barbed tip of the tail. */
	tail: 'M6,0Q3,-4 -2,-5L-16,-11L-9,-2.5L-24,0L-9,2.5L-16,11L-2,5Q3,4 6,0Z',
};
