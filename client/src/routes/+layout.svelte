<script>
  import '../app.css';
  import { initTheme } from '$lib/theme.svelte.js';

  let { children } = $props();

  // Reconciles the store with whatever the pre-paint script in app.html already put on
  // <html>, so the toggle's first click always flips away from what the user is seeing.
  initTheme();
</script>

{@render children?.()}
