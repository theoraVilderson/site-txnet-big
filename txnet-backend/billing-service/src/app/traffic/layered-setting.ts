/**
 * A setting resolved over layers (F-027-cg, ADR-0090 decision 2): the first
 * layer that sets it answers, else the platform's default. One home for the
 * rule, so the selling settings (member -> panel) and the self-move setting
 * (product -> tenant, F-410-a) cannot drift apart on what "not set" means.
 */

/** One layer's own values: null (or absent) = not set at this layer. `false` and `0` are values. */
export type LayerValues<V> = { [K in keyof V]?: V[K] | null };

/** Each setting's effective value and the layer it came from, so a page can say "inherited". */
export type Resolved<V, L extends string> = { [K in keyof V]: { value: V[K]; layer: L } };

/**
 * Every key of `defaults`, from the first of `layers` (nearest first) that sets
 * it, else `defaults` as `platformLayer`. A null layer — a row that does not
 * exist — sets nothing.
 */
export function resolveLayers<V extends object, L extends string, P extends string>(
  layers: ReadonlyArray<readonly [L, LayerValues<V> | null]>,
  defaults: Readonly<V>,
  platformLayer: P,
): Resolved<V, L | P> {
  const keys = Object.keys(defaults) as (keyof V)[];
  const pick = <K extends keyof V>(key: K): { value: V[K]; layer: L | P } => {
    for (const [layer, values] of layers) {
      const own = values?.[key];
      if (own !== null && own !== undefined) return { value: own as V[K], layer };
    }
    return { value: defaults[key], layer: platformLayer };
  };
  return Object.fromEntries(keys.map((key) => [key, pick(key)])) as Resolved<V, L | P>;
}
