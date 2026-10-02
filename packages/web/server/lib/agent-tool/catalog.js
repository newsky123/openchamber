import { z } from 'zod';
import {
  OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
  OPENCHAMBER_WEB_ACTION_DEFINITIONS,
  OPENCHAMBER_MEMORY_ACTION_DEFINITIONS,
  OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS,
} from '../openchamber-control/actions.js';

/**
 * Each tool carries only the inputs its own actions take.
 *
 * A shared parameter object would leave a disabled capability's inputs visible
 * in the other tool's schema, which is both misleading and paid for in context
 * on every call.
 */
const WEB_PARAMETER_NAMES = ['url', 'selector', 'text', 'value', 'submit', 'direction', 'viewport', 'label', 'tabId'];
// `title` is shared with the control tool, so it is not listed here — only the
// names memory alone introduces are kept out of the other schemas.
const MEMORY_ONLY_PARAMETER_NAMES = ['body', 'scope', 'memoryId', 'type'];
const MEMORY_PARAMETER_NAMES = [...MEMORY_ONLY_PARAMETER_NAMES, 'title'];

/**
 * `title` is shared with the control tool, where it means a session title, so
 * it carries no description in the shared map. Left undescribed for memory the
 * model has nothing to go on and invents a name for it — `name` was sent
 * repeatedly in practice — so memory states what its own `title` is.
 */
const MEMORY_PARAMETER_OVERRIDES = {
  title: { type: 'string', description: "The memory's title, exactly as the session index lists it. Use this to read an entry you can already see; use memoryId only when a result gave you one" },
  scope: { type: 'string', enum: ['global', 'project', 'both'], description: 'global is about the user and applies everywhere; project is about this codebase. Required for memory.save and memory.delete. Optional for memory.read and memory.list, which search both stores when it is omitted' },
};

const ALL_PARAMETER_PROPERTIES = {
  projectId: { type: 'string', description: 'Configured project ID; do not combine with directory' },
  directory: { type: 'string', description: 'Absolute checkout or session directory; defaults to the current session directory' },
  sessionId: { type: 'string' },
  messageId: { type: 'string', description: 'Optional fork boundary message ID' },
  taskId: { type: 'string' },
  title: { type: 'string' },
  prompt: { type: 'string' },
  model: { type: 'string', description: 'Model in provider/model format. When the user names no model: for session.create pick a suitable one from models.list favorites or recents (omit if there are none); for send and fork omit it — the session reuses its previous model' },
  agent: { type: 'string', description: 'OpenCode agent name; new sessions default to the build agent and existing sessions keep their previous one. Set only when the user explicitly requests a different agent' },
  variant: { type: 'string', description: 'Model variant; use only when the user explicitly requests it' },
  worktree: { type: 'string', description: 'New worktree name for session.create. Omit by default; use only when the user explicitly asks for an isolated worktree. Uncommitted changes do not carry over into a new worktree' },
  branch: { type: 'string', description: 'Branch name for the new worktree' },
  startRef: { type: 'string', description: 'Git ref used to create the new worktree' },
  setUpstream: { type: 'boolean', description: 'Make the new worktree branch track its upstream' },
  goal: { type: 'boolean', description: 'Run the dispatched prompt in Goal Mode; use only when the user explicitly requests it' },
  goalTokenBudget: { type: 'integer', minimum: 1000, maximum: 100_000_000, description: 'Goal token budget; requires goal' },
  wait: { type: 'boolean', description: 'Wait for current session activity to become idle. Omit by default; use only when the user asks or the next step requires the completed result' },
  timeout: { type: 'integer', minimum: 1, maximum: 86_400, description: 'Wait timeout in seconds (default 600); requires wait' },
  lastAssistant: { type: 'boolean', description: 'Return the last assistant text; create/send/fork require wait' },
  limit: { type: 'integer', minimum: 1, description: 'Maximum sessions or messages to return (default 10)' },
  all: { type: 'boolean', description: 'Include archived sessions or all messages, depending on the action' },
  last: { type: 'boolean', description: 'Return only the last matching session message' },
  withStatus: { type: 'boolean', description: 'Include authoritative status in session.list' },
  role: { type: 'string', enum: ['all', 'user', 'assistant'], description: 'Message role filter' },
  name: { type: 'string' },
  daily: { type: 'string', description: 'Daily run time in HH:mm format' },
  weekly: { type: 'string', description: 'Comma-separated weekdays; 0=Sunday and 6=Saturday' },
  once: { type: 'string', description: 'One-time run date in YYYY-MM-DD format' },
  time: { type: 'string', description: 'Weekly or one-time run time in HH:mm format' },
  cron: { type: 'string', description: 'Cron expression' },
  timezone: { type: 'string', description: 'IANA timezone' },
  disabled: { type: 'boolean', description: 'true disables and false enables; required for schedule.toggle' },
  path: { type: 'string', description: 'File to show for file.open; absolute, or relative to the session directory' },
  url: { type: 'string', description: 'http(s) URL for browser.open' },
  selector: { type: 'string', description: 'CSS selector from a browser.snapshot result' },
  text: { type: 'string', description: 'Visible label to match when no selector is given' },
  value: { type: 'string', description: 'Text to type for browser.type' },
  submit: { type: 'boolean', description: 'Press Enter after typing' },
  direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction for browser.scroll' },
  viewport: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'fill'], description: 'Page layout size; snapshots report which one is in effect' },
  label: { type: 'string', description: 'Short name for a browser.capture image, such as before-fix' },
  tabId: { type: 'string', description: 'Browser tab to act on, an id from the tabs a browser.snapshot lists. Omit to use the tab the user is looking at' },
  body: { type: 'string', description: 'Full text of the memory; state it so it still makes sense in a session that has none of this conversation' },
  scope: { type: 'string', enum: ['global', 'project', 'both'], description: 'global is about the user and applies everywhere; project is about this codebase. both is only valid for memory.list' },
  memoryId: { type: 'string', description: 'Memory ID from a memory.list or memory.read result' },
  type: { type: 'string', enum: ['fact', 'preference', 'reference'], description: 'fact is something true, preference is how the user wants work done, reference points at a resource that is hard to find again' },
};

const pickParameters = (names) => Object.fromEntries(
  Object.entries(ALL_PARAMETER_PROPERTIES).filter(([name]) => names.includes(name)),
);

const CONTROL_PARAMETER_PROPERTIES = pickParameters(
  Object.keys(ALL_PARAMETER_PROPERTIES).filter((name) => (
    !WEB_PARAMETER_NAMES.includes(name) && !MEMORY_ONLY_PARAMETER_NAMES.includes(name)
  )),
);
const WEB_PARAMETER_PROPERTIES = pickParameters(WEB_PARAMETER_NAMES);
const MEMORY_PARAMETER_PROPERTIES = {
  ...pickParameters(MEMORY_PARAMETER_NAMES),
  ...MEMORY_PARAMETER_OVERRIDES,
};

// Its own names, not the shared map: `title` and `body` mean something else in
// the control and memory tools.
const NOTIFY_PARAMETER_PROPERTIES = {
  title: { type: 'string', description: 'Short headline the user reads first, up to 120 characters' },
  body: { type: 'string', description: 'One or two sentences of detail, up to 500 characters' },
  showWhenFocused: { type: 'boolean', description: 'Show it even while the user is looking at OpenChamber. Only for something that cannot wait' },
};

const CONTROL_TOOL_DESCRIPTION = "Control OpenChamber projects, sessions, and scheduled tasks on the user's behalf. Sessions and scheduled tasks you create are for the user to follow and interact with. Do not decide on your own to hand parts of your current task to another session; when the user asks you to create a session, send a prompt to one, or schedule a task, do it, including when the work relates to your current task. Use one action per call. Scope with projectId or directory; omit both to use the current session directory. Session dispatches return immediately by default and you receive no notification when a dispatched session finishes, so never promise to report back on it; the user follows it in OpenChamber; a dispatched session needs no follow-up from you. If the user later asks how it went, use session.messages (add wait to block until it is idle, lastAssistant for just the final answer) — session.send always sends a NEW prompt and never just waits. Set wait only when the user asks or the next step requires the completed result. Session and worktree deletion are unavailable.";

const WEB_TOOL_DESCRIPTION = "Look at and interact with a web page in OpenChamber's browser panel, so you can check your own work rather than describing what you expect. Use one action per call. Open a page, snapshot it to read its text and its interactive elements, then click, type or scroll using the selectors the snapshot returned; snapshots also report any errors the page logged. Pass a selector to browser.snapshot to read one part of a long page. browser.inspect returns computed styles when the question is how something renders. Set viewport to check a layout at mobile, tablet or desktop size. The page runs with the user's real logins, so treat what you see as their live session.";

const MEMORY_TOOL_DESCRIPTION = "Keep what you learn across sessions, so the user does not have to explain the same thing twice. Use one action per call. The session already lists the titles of what is stored. A title is an abbreviation, not the memory: read the entry with memory.read once before acting on it (it then stays in your context; do not re-read it on later turns), because titles leave out the conditions and exceptions that decide how the memory applies, and the ones that look self-explanatory hide them most often. Save something only when it will still be true in a later session — a stable preference, a project convention, a decision and its reason, or a hard-won pointer. Do not save one-off task state, anything you can read from the code, secrets or credentials, or anything the user asked you not to keep; when the user explicitly asks you to remember something, save it, unless it is a secret or credential. Choose the scope deliberately: global is about the user and reaches every project, so put a project's conventions in project scope. Save in the moment, without asking first, when the user corrects how you work or states a preference, confirms that a non-obvious approach worked, or when you learn a project fact that took real effort to find. One fact per entry. The user can review and remove what you save, so save when it fits and mention it briefly.";

const NOTIFY_TOOL_DESCRIPTION = "Send the user a notification through OpenChamber, so they learn about something without watching the session. Use it when you finish work that took long enough for the user to step away, when you are blocked on something only the user can resolve, or when the user asked to be told about something. Do not use it for routine progress, for every finished step, or to repeat what your reply already says to a user who is present. Keep the title short and put detail in the body.";

const definitions = [
  { name: 'openchamber', setting: 'agentControlToolEnabled', defaultEnabled: true, description: CONTROL_TOOL_DESCRIPTION, actions: OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, parameters: CONTROL_PARAMETER_PROPERTIES },
  { name: 'openchamber_web', setting: 'agentWebToolEnabled', defaultEnabled: true, description: WEB_TOOL_DESCRIPTION, actions: OPENCHAMBER_WEB_ACTION_DEFINITIONS, parameters: WEB_PARAMETER_PROPERTIES },
  { name: 'openchamber_memory', setting: 'agentMemoryToolEnabled', defaultEnabled: false, description: MEMORY_TOOL_DESCRIPTION, actions: OPENCHAMBER_MEMORY_ACTION_DEFINITIONS, parameters: MEMORY_PARAMETER_PROPERTIES },
  { name: 'openchamber_notify', setting: 'agentNotifyToolEnabled', defaultEnabled: false, description: NOTIFY_TOOL_DESCRIPTION, actions: OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS, parameters: NOTIFY_PARAMETER_PROPERTIES },
];

export const AGENT_TOOL_DEFINITIONS = definitions;

// Data for the adapter compiled into the managed OpenCode binary. No module
// path, source code, import specifier, or executable content crosses this pipe.
export const createAgentToolCatalog = () => definitions.map((definition) => ({
  name: definition.name,
  description: definition.description,
  actionTitles: Object.fromEntries(definition.actions.map(({ action, title }) => [action, title])),
  input: {
    type: 'object',
    properties: {
      action: { type: 'string', oneOf: definition.actions.map(({ action, description }) => ({ const: action, description })) },
      parameters: { type: 'object', properties: definition.parameters, additionalProperties: false },
      ...definition.parameters,
    },
    required: ['action'],
    additionalProperties: false,
  },
}));

export const isAgentToolEnabled = (definition, settings, memoryAvailable) => (
  (definition.name !== 'openchamber_memory' || memoryAvailable)
  && (definition.defaultEnabled ? settings[definition.setting] !== false : settings[definition.setting] === true)
);

export const agentToolSettingsSchema = z.object({
  agentControlToolEnabled: z.boolean().optional(),
  agentWebToolEnabled: z.boolean().optional(),
  agentMemoryToolEnabled: z.boolean().optional(),
  agentNotifyToolEnabled: z.boolean().optional(),
  agentToolsCodeMode: z.boolean().optional(),
});
