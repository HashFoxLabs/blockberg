import { writable } from 'svelte/store';

export type TradingMode = 'regular';

export interface TradingContext {
	mode: TradingMode;
}

function createTradingModeStore() {
	const { subscribe, set } = writable<TradingContext>({
		mode: 'regular',
	});

	return {
		subscribe,
		setRegularMode: () => set({ mode: 'regular' }),
		get: (): Promise<TradingContext> => {
			return new Promise((resolve) => {
				subscribe((value) => {
					resolve(value);
				})();
			});
		},
	};
}

export const tradingModeStore = createTradingModeStore();
