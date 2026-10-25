// Public connection settings for the Supabase projects. Project URLs and
// publishable keys are designed to be public; access is enforced by the
// database's own rules. Secret keys never go in this repo.

// The real project. The app uses this one.
export const SUPABASE_URL = 'https://ogseunsakzzjvgyhcoyg.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_sjlcxSziT69x7c_eY7hUYQ_zWRJMSrt';

// The test project. Only the privacy tests use this one.
export const TEST_SUPABASE_URL = 'https://bmvedtplptryihdfhavc.supabase.co';
export const TEST_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_jT5u7XTTjkvE_UclkIavAg_H5ZuKY9C';
