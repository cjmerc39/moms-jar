// Public connection settings for the real Supabase project. The project URL
// and publishable key are designed to be public; access is enforced by the
// database's own rules. Secret keys never go in this repo.
//
// These are the only connection settings the app has. There is deliberately
// no way to switch projects at runtime (no URL parameters, no stored
// overrides); config.test.js fails if that changes.

export const SUPABASE_URL = 'https://ogseunsakzzjvgyhcoyg.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_sjlcxSziT69x7c_eY7hUYQ_zWRJMSrt';
