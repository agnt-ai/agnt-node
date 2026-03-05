/**
 * System tool names — tools that are handled natively by the executor/platform.
 * Tool calls NOT in this set are considered 'custom' and may trigger pause/resume.
 */
export const SYSTEM_TOOL_NAMES = new Set([
  'finish_agent_run',
  'output',
  'web_search',
  'get_weather',
  'perform_calculation',
  // Skill plugin tools — resolved at execution time from mounted skills
  'fetch_skills',
  'read_skill',
]);
