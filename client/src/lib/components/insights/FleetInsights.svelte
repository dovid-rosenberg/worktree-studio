<script>
  /*
   * The Insights view: fleet-wide token and cost telemetry, as a peer of Overview.
   *
   * UsagePanel already computed exactly this — one hero total, a KPI row, a cost ranking
   * groupable by feature or session, and a per-session token/model breakdown — but the
   * only thing mounting it was the /usage dev harness, so nothing in the app could reach
   * it. The dock's Insights TAB is a different thing and stays: that one is scoped to the
   * selected session. This is the whole fleet.
   *
   * Selecting a row here jumps to that session, which is why the panel takes `onselect`
   * rather than owning navigation itself.
   */
  import UsagePanel from '$lib/components/insights/UsagePanel.svelte';
  import { ui } from '$lib/stores/ui.svelte.js';

  // Seed the panel's initial row with whatever the shell has selected, so opening
  // Insights while looking at a session lands on that session's breakdown.
  const seed = $derived(ui.selectedId);
</script>

<div class="fleetinsights">
  <UsagePanel sessionId={seed} onselect={(/** @type {string} */ id) => ui.goToSession(id)} />
</div>

<style>
  .fleetinsights { flex: 1; min-height: 0; overflow-y: auto; background: var(--bg); }
</style>
