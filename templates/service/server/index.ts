// Headless Fleet service — no client/index.tsx needed.
// Export queries, mutations, jobs, and event subscribers.
export default {
  queries: {
    recent(ctx) {
      return ctx.db.get('recent') ?? [];
    },
  },
  mutations: {
    ping(ctx, input) {
      const payload = { at: new Date().toISOString(), input: input ?? null };
      ctx.emit('service.ping', payload);
      return payload;
    },
  },
  events: {
    // Match exact topics ("workout.logged") or trailing wildcards ("alert.*", "*").
    'service.ping'(ctx, payload) {
      const recent = ctx.db.get('recent') ?? [];
      const entry = {
        id: ctx.eventId,
        topic: ctx.event?.topic,
        source: ctx.event?.source,
        payload,
      };
      const next = [entry, ...recent.slice(0, 49)];
      // Keep stored history well under the 2 MB ctx.db value limit even for large payloads.
      while (next.length > 1 && JSON.stringify(next).length > 512_000) {
        next.pop();
      }
      ctx.db.set('recent', next);
      ctx.log('Received', ctx.event?.topic, 'from', ctx.event?.source);
    },
  },
};
