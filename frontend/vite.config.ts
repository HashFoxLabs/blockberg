import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
	plugins: [
		sveltekit(),
		nodePolyfills({
			// Omit `process` from polyfills: injecting `globalThis.process` breaks Node SSR
			// (`process.cwd is not a function` in SvelteKit), and stdlib's `process/` proxy
			// breaks esbuild's dependency scan for some wallet deps.
			include: ['buffer', 'util', 'stream', 'events'],
			globals: {
				process: false,
				Buffer: true,
				global: true,
			},
		}),
	],
	define: {
		'process.env': {},
	},
	ssr: {
		noExternal: ['@solana/wallet-adapter-wallets', '@solana/wallet-adapter-base'],
	},
	optimizeDeps: {
		include: ['react', 'react-dom'],
		esbuildOptions: {
			target: 'esnext',
		},
	},
});
