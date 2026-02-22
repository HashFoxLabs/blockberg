<script lang="ts">
	import { toastStore, type Toast } from './store';
	import { fly, fade } from 'svelte/transition';

	let toasts: Toast[] = [];

	toastStore.subscribe((value) => {
		toasts = value;
	});

	function getIcon(type: Toast['type']) {
		switch (type) {
			case 'success':
				return '✓';
			case 'error':
				return '✕';
			case 'warning':
				return '⚠';
			case 'info':
				return 'ℹ';
		}
	}
</script>

<div class="toast-container">
	{#each toasts as toast (toast.id)}
		<div
			class="toast toast-{toast.type}"
			in:fly={{ y: -20, duration: 300 }}
			out:fade={{ duration: 200 }}
		>
			<div class="toast-header">
				<div class="toast-icon">{getIcon(toast.type)}</div>
				<div class="toast-title">{toast.title}</div>
				<button class="toast-close" on:click={() => toastStore.remove(toast.id)}>×</button>
			</div>
			<div class="toast-message">{toast.message}</div>
		</div>
	{/each}
</div>

<style>
	.toast-container {
		position: fixed;
		top: 80px;
		right: 20px;
		z-index: 10000;
		display: flex;
		flex-direction: column;
		gap: 10px;
		max-width: 380px;
	}

	.toast {
		background: #000;
		border: 1px solid #333;
		padding: 0;
		font-family: 'Courier New', 'Lucida Console', monospace;
		animation: slideIn 0.3s ease-out;
	}

	.toast-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		border-bottom: 1px solid #333;
	}

	.toast-success .toast-header {
		background: #0a0a0a;
		border-left: 3px solid #00ff00;
	}

	.toast-error .toast-header {
		background: #0a0a0a;
		border-left: 3px solid #ff4444;
	}

	.toast-warning .toast-header {
		background: #0a0a0a;
		border-left: 3px solid #ff9500;
	}

	.toast-info .toast-header {
		background: #0a0a0a;
		border-left: 3px solid #ff9500;
	}

	.toast-icon {
		font-size: 14px;
		font-weight: bold;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.toast-success .toast-icon {
		color: #00ff00;
	}

	.toast-error .toast-icon {
		color: #ff4444;
	}

	.toast-warning .toast-icon {
		color: #ff9500;
	}

	.toast-info .toast-icon {
		color: #ff9500;
	}

	.toast-title {
		flex: 1;
		font-weight: bold;
		font-size: 11px;
		letter-spacing: 1px;
		text-transform: uppercase;
	}

	.toast-success .toast-title {
		color: #00ff00;
	}

	.toast-error .toast-title {
		color: #ff4444;
	}

	.toast-warning .toast-title {
		color: #ff9500;
	}

	.toast-info .toast-title {
		color: #ff9500;
	}

	.toast-message {
		padding: 12px;
		font-size: 12px;
		color: #ccc;
		line-height: 1.5;
		word-break: break-word;
		background: #000;
	}

	.toast-close {
		background: none;
		border: 1px solid #333;
		color: #666;
		font-size: 16px;
		cursor: pointer;
		padding: 2px 8px;
		line-height: 1;
		transition: all 0.2s;
		font-family: 'Courier New', monospace;
	}

	.toast-close:hover {
		color: #ff9500;
		border-color: #ff9500;
	}

	@keyframes slideIn {
		from {
			transform: translateX(100%);
			opacity: 0;
		}
		to {
			transform: translateX(0);
			opacity: 1;
		}
	}
</style>
