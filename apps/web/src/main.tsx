import { render } from 'preact/compat';
import App from './App';
// eslint-disable-next-line import/no-unassigned-import -- side-effect stylesheet import
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

// No StrictMode: preact/compat has no double-invoke semantics to offer, so the
// wrapper would only be ceremony.
render(<App />, root);
