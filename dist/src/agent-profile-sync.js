/**
 * Materializes Gateway agent profiles as OpenClaw `agents.entries.<agentId>`.
 *
 * The Gateway owns the organization/department/agent-profile records; when a
 * conversation is bound to a bot + agent profile it pushes `V2.AGENT_PROFILE_SYNC`
 * so the running OpenClaw instance declares that main agent. This keeps the
 * "one bot -> multiple main agents" loop working without the plugin guessing
 * OpenClaw session keys or reimplementing an agent runtime.
 */
function normalized(value, fallback = '') {
    if (typeof value !== 'string')
        return fallback;
    return value.trim();
}
let configMutatorOverride = null;
export function setConfigMutatorForTest(fn) {
    configMutatorOverride = fn;
}
async function loadUpdateConfig() {
    const moduleName = 'openclaw/plugin-sdk/config-mutation';
    const runtime = await import(moduleName);
    if (typeof runtime?.updateConfig !== 'function') {
        throw new Error('OpenClaw config mutation unavailable');
    }
    return runtime.updateConfig;
}
export async function handleAgentProfileSync(options) {
    const req = (options.request || {});
    const agentId = normalized(req.agent_id);
    const name = normalized(req.name);
    const model = normalized(req.model);
    const config = req.config && typeof req.config === 'object' && !Array.isArray(req.config)
        ? req.config
        : {};
    try {
        if (!agentId) {
            options.sendAck({ ok: false, error: 'missing agent_id' });
            return;
        }
        const updateConfig = configMutatorOverride ?? (await loadUpdateConfig());
        await updateConfig((cfg) => {
            cfg.agents = cfg.agents ?? {};
            cfg.agents.entries = cfg.agents.entries ?? {};
            const existing = cfg.agents.entries[agentId] ?? {};
            const next = { ...existing };
            if (name)
                next.name = name;
            if (model)
                next.model = model;
            if (Object.keys(config).length > 0) {
                Object.assign(next, config);
            }
            cfg.agents.entries[agentId] = next;
            return cfg;
        });
        options.sendAck({ ok: true, agent_id: agentId });
    }
    catch (err) {
        options.sendAck({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
