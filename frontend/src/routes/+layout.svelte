<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
	<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
	<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
	<link rel="icon" type="image/png" sizes="192x192" href="/android-chrome-192x192.png" />
	<link rel="icon" type="image/png" sizes="512x512" href="/android-chrome-512x512.png" />
</svelte:head>

{@render children?.()}

<style>
	:global(body) {
		font-family: Arial, Helvetica, sans-serif;
		margin: 0;
		padding: 0;
	}
</style>
