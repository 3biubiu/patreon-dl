// Serves the built ffmpeg assets, the check page and node_modules, so the
// browser sees the same files the application serves. The page posts its
// result back to /result, which is printed here.
import express from 'express';
import path from 'path';

const root = process.cwd();
const app = express();
app.use('/assets', express.static(path.join(root, 'dist/browse/web/assets')));
app.use('/node_modules', express.static(path.join(root, 'node_modules')));
app.post('/result', express.text({ type: '*/*' }), (req, res) => {
  console.log('===== BROWSER RESULT =====');
  console.log(req.body);
  console.log('==========================');
  res.end();
});
app.use(express.static(path.join(root, 'tmp-ffmpeg-check')));

app.listen(4599, () => console.log('http://127.0.0.1:4599/'));
