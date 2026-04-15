import { writable } from 'svelte/store';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
	id: number;
	type: ToastType;
	title: string;
	message: string;
	duration?: number;
}

function createToastStore() {
	const { subscribe, update } = writable<Toast[]>([]);
	let nextId = 0;

	function add(toast: Omit<Toast, 'id'>) {
		const id = nextId++;
		const duration = toast.duration ?? 5000;

		update((toasts) => [...toasts, { ...toast, id }]);

		if (duration > 0) {
			setTimeout(() => {
				remove(id);
			}, duration);
		}

		return id;
	}

	function remove(id: number) {
		update((toasts) => toasts.filter((t) => t.id !== id));
	}

	function success(title: string, message: string, duration?: number) {
		return add({ type: 'success', title, message, duration });
	}

	function error(title: string, message: string, duration?: number) {
		return add({ type: 'error', title, message, duration: duration ?? 8000 });
	}

	function info(title: string, message: string, duration?: number) {
		return add({ type: 'info', title, message, duration });
	}

	function warning(title: string, message: string, duration?: number) {
		return add({ type: 'warning', title, message, duration: duration ?? 6000 });
	}

	return {
		subscribe,
		add,
		remove,
		success,
		error,
		info,
		warning
	};
}

export const toastStore = createToastStore();
