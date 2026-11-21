// Fleet supplies identity, persistent data, and scheduling. Queries are read-only.
export default {
  queries: {
    notes(ctx) {
      return ctx.db.get('notes') ?? [];
    },
  },
  mutations: {
    addNote(ctx, input) {
      if (typeof input?.text !== 'string' || !input.text.trim() || input.text.length > 10000) {
        throw new Error('Enter a note of at most 10,000 characters.');
      }
      const notes = ctx.db.get('notes') ?? [];
      if (notes.length >= 500) throw new Error('This starter app holds up to 500 notes.');
      const note = { id: crypto.randomUUID(), text: input.text.trim(), createdAt: new Date().toISOString() };
      ctx.db.set('notes', [note, ...notes]);
      return note;
    },
    deleteNote(ctx, input) {
      const notes = ctx.db.get('notes') ?? [];
      ctx.db.set('notes', notes.filter(note => note.id !== input?.id));
    },
  },
  jobs: {
    // Add { "name": "dailyCheck", "everySeconds": 86400 } to fleet.json jobs.
    dailyCheck(ctx) {
      ctx.db.set('lastCheck', new Date().toISOString());
      ctx.log('Daily check completed', ctx.runId);
    },
  },
};
