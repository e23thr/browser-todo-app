import { render } from 'preact';

import { App } from './App';
import '../styles/global.css';

const container = document.getElementById('app');
if (container === null) {
  throw new Error('Missing #app mount point in index.html');
}

render(<App />, container);
