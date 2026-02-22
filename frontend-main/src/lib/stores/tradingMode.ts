import { writable } from 'svelte/store';

export type TradingMode = 'regular' | 'tournament';

export interface TradingContext {
	mode: TradingMode;
	tournamentId?: number; // Only set when mode is 'tournament'
}

function createTradingModeStore() {
	const { subscribe, set, update } = writable<TradingContext>({
		mode: 'regular'
	});

	return {
		subscribe,
		setRegularMode: () => set({ mode: 'regular' }),
		setTournamentMode: (tournamentId: number) => set({
			mode: 'tournament',
			tournamentId
		}),
		get: (): Promise<TradingContext> => {
			return new Promise((resolve) => {
				subscribe((value) => {
					resolve(value);
				})();
			});
		}
	};
}

export const tradingModeStore = createTradingModeStore();
