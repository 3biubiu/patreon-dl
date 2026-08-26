// antd v5 still targets React 18; this shim keeps its static message / modal
// helpers working on React 19 and silences the compatibility warning.
import '@ant-design/v5-patch-for-react-19';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
