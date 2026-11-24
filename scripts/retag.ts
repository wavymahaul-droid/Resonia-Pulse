// Re-tag every stored post with the current keyword rules in themes.json.
// Themes changed by hand on the dashboard are kept.
//   npm run retag
import { supabaseAdmin } from "../lib/supabase";
import { tagPosts } from "../lib/themes";

const changed = await tagPosts(supabaseAdmin(), { all: true });
console.log(`Posts whose theme changed: ${changed} (themes edited on the dashboard are kept)`);
