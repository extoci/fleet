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
      ctx.db.set('recent', [
        { id: ctx.eventId, topic: ctx.event?.topic, source: ctx.event?.source, payload },
        ...recent.slice(0, 49),
      ]);
      ctx.log('Received', ctx.event?.topic, 'from', ctx.event?.source);
    },
  },
};
