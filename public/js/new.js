// Creates a meeting key locally and hands it to the room page in the URL
// fragment. The key is never sent to the server.
import { newSecret } from './crypto.js';

const key = newSecret();
sessionStorage.setItem('bb:session', key);
sessionStorage.setItem('bb:creator', '1');
location.replace(`/room${location.search}#${key}`);
