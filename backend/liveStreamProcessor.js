const crypto = require('crypto');

function createLiveStreamProcessor({ windowMs = 10_000, maxBatchSize = 250, onFlush }) {
    if (typeof onFlush !== 'function') {
        throw new Error('onFlush callback is required.');
    }

    let buffer = [];
    let timer = null;
    let activeFlush = null;

    function scheduleTimer() {
        if (timer) {
            return;
        }

        timer = setInterval(() => {
            void flush('timer');
        }, windowMs);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    }

    function normalizeEvents(events) {
        const list = Array.isArray(events) ? events : [events];
        return list.filter(Boolean).map(event => ({ ...event }));
    }

    async function flush(reason = 'manual') {
        if (activeFlush) {
            return activeFlush;
        }

        if (buffer.length === 0) {
            return null;
        }

        const batch = buffer;
        buffer = [];

        const batchId = crypto.createHash('sha256')
            .update(JSON.stringify(batch))
            .digest('hex')
            .slice(0, 16);

        activeFlush = (async () => onFlush({ batchId, events: batch, reason }))();

        try {
            return await activeFlush;
        } finally {
            activeFlush = null;
        }
    }

    async function enqueue(events) {
        const normalized = normalizeEvents(events);
        if (normalized.length === 0) {
            return { accepted: 0, queued: buffer.length };
        }

        scheduleTimer();
        buffer.push(...normalized);

        if (buffer.length >= maxBatchSize) {
            await flush('max-batch');
        }

        return { accepted: normalized.length, queued: buffer.length };
    }

    function start() {
        scheduleTimer();
    }

    async function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }

        return flush('shutdown');
    }

    return {
        enqueue,
        flush,
        start,
        stop,
        getQueuedCount: () => buffer.length,
    };
}

module.exports = {
    createLiveStreamProcessor,
};