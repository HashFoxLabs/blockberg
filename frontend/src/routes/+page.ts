import { redirect } from '@sveltejs/kit';

export const ssr = false;

export const load = () => {
  throw redirect(307, '/terminal');
};
