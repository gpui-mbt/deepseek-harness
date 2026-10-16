/**
 * Program faces of the repository's Typert pass. The Host face alone emits
 * Host reflection and the Host-for-Client Remote projection; no package
 * publishes Client reflection. The Host pack plugin (`pack.config.ts`)
 * and the bundle-free pass (`generate-typert.ts`) both generate exactly these faces.
 */
export const WORKSPACE_TYPERT_FACES = ['host'] as const
