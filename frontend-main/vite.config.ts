import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
	plugins: [
		sveltekit(),
		nodePolyfills({
			include: ['process', 'buffer', 'util', 'stream', 'events'],
			globals: {
				process: true,
				Buffer: true,
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
