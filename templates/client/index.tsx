import { render, type TargetedSubmitEvent } from 'preact';
import { useState } from 'preact/hooks';
import { useMutation, useQuery } from 'fleet/client';
import './style.css';

type Note = {
  id: string;
  text: string;
  createdAt: string;
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function App() {
  const { data: notes, error } = useQuery<Note[]>('notes');
  const add = useMutation<Note, { text: string }>('addNote');
  const remove = useMutation<void, { id: string }>('deleteNote');
  const [text, setText] = useState('');
  const [failure, setFailure] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: TargetedSubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !text.trim()) return;

    setSaving(true);
    setFailure('');
    try {
      await add({ text });
      setText('');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not save the note.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteNote(id: string) {
    setFailure('');
    try {
      await remove({ id });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not delete the note.');
    }
  }

  return (
    <>
      <link rel="stylesheet" href="/fleet/fonts.css" />
      <header class="topbar">
        <div class="topbar-inner">
          <img src="/fleet/wordmark.svg" alt="Fleet" width="96" height="32" />
          <a href="https://gate.fleet">
            Open Gate <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>

      <main>
        <div class="intro">
          <h1>Notes</h1>
          <p>Your notes stay on the computer that runs this app.</p>
        </div>

        <form class="composer" onSubmit={submit}>
          <label htmlFor="note">New note</label>
          <textarea
            id="note"
            value={text}
            onInput={(event) => setText(event.currentTarget.value)}
            maxLength={10000}
            readOnly={saving}
            required
          />
          <button class="save" type="submit" disabled={saving || !text.trim()}>
            {saving ? 'Saving…' : 'Save note'}
          </button>
        </form>

        {failure && <p class="error" role="alert">{failure}</p>}

        <section class="notes" aria-labelledby="saved-notes">
          <h2 id="saved-notes">Saved notes</h2>
          {error && <p class="error" role="alert">{error.message}</p>}
          {notes === undefined && !error && <p class="notes-status" role="status">Loading notes…</p>}
          {notes?.length === 0 && !error && <p class="notes-status">No notes yet.</p>}
          {!!notes?.length && (
            <ul>
              {notes.map((note) => (
                <li key={note.id}>
                  <p>{note.text}</p>
                  <footer>
                    <time dateTime={note.createdAt}>{dateFormat.format(new Date(note.createdAt))}</time>
                    <button class="delete" type="button" onClick={() => deleteNote(note.id)}>
                      Delete
                    </button>
                  </footer>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

render(<App />, document.getElementById('app')!);
