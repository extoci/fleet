import { render } from 'preact';
import { useState } from 'preact/hooks';
import { useQuery, useMutation } from 'fleet/client';
import './style.css';

function App() {
  const { data: notes, error } = useQuery('notes');
  const add = useMutation('addNote');
  const remove = useMutation('deleteNote');
  const [text, setText] = useState('');
  const [failure, setFailure] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event) {
    event.preventDefault(); setSaving(true); setFailure('');
    try { await add({ text }); setText(''); }
    catch (error) { setFailure(error.message); }
    finally { setSaving(false); }
  }
  return <main>
    <nav><a href="https://gate.fleet">FLEET</a><span>PRIVATE NOTES</span></nav>
    <h1>A place for<br />your thoughts.</h1>
    <p class="intro">Your notes stay on your computer. Open them on any of your Fleet devices.</p>
    <form onSubmit={submit}>
      <label htmlFor="note">New note</label>
      <textarea id="note" placeholder="What's on your mind?" value={text} onInput={event => setText(event.currentTarget.value)} maxLength={10000} required />
      <button disabled={saving || !text.trim()}>{saving ? 'Saving…' : 'Save note'}</button>
    </form>
    {(failure || error) && <p class="error" role="alert">{failure || error.message}</p>}
    {notes === undefined ? <p role="status">Opening your notes…</p> : notes.length === 0 ? <p class="empty">Your first note starts here.</p> :
      <section aria-label="Your notes">{notes.map(note => <article key={note.id}><p>{note.text}</p><footer><time dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleDateString()}</time><button class="delete" onClick={async () => { try { await remove({ id: note.id }); } catch (error) { setFailure(error.message); } }}>Delete</button></footer></article>)}</section>}
  </main>;
}
render(<App />, document.getElementById('app'));
