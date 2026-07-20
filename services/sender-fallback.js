/**
 * Builds the safe sender-ID attempt order for a single SMS send.
 * The caller controls retry eligibility; this helper only selects candidates.
 */
function buildSenderAttemptOrder({ assignedSenderId, globalSenderIds, envSenderId } = {}) {
    const candidates = [];
    const add = (value) => {
        const senderId = String(value || '').trim();
        if (senderId && !candidates.includes(senderId)) candidates.push(senderId);
    };

    add(assignedSenderId);

    const globals = Array.isArray(globalSenderIds) ? globalSenderIds : [];
    for (const sender of globals) add(sender?.value);

    if (globals.length === 0) add(envSenderId);

    return candidates;
}

module.exports = { buildSenderAttemptOrder };
