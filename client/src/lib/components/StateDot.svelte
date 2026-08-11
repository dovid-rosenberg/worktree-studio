<script lang="ts">
/*
 * The state indicator — one component, so it has one accessibility treatment.
 *
 * `.dot` (app.css) encodes five states in hue plus shape, and it was mounted at eight
 * places with four different treatments: `role="img"` with a label at three, a bare
 * `title` at one, and NOTHING at the other four. The one that mattered is FeatureCard,
 * the app's primary scan surface: its state pill is deliberately suppressed for `idle`
 * and `stopped` (absence is how `waiting` becomes findable), so for those two states the
 * dot was the ONLY carrier of the agent's state — and it carried it in hue alone. A
 * screen reader on the main list got no agent state at all.
 *
 * So the name is not optional here. `label` overrides the default sentence for the mounts
 * where the dot means something other than an agent — a running dev server, a legend
 * swatch — but there is no way to render this without one.
 *
 * `title` as well as `aria-label`: the tooltip is what a sighted user hovers to tell
 * `idle` from `stopped`, which differ only by a 1.5px inset ring.
 */
let { state, label }: { state: string; label?: string } = $props();

const name = $derived(label ?? `Agent is ${state}`);
</script>

<span class="dot {state}" role="img" aria-label={name} title={name}></span>
