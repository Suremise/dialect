- **Project:** saidvandeklundert/juniper-config-converter
- **URL:** https://github.com/saidvandeklundert/juniper-config-converter
- **License:** MIT, Copyright (c) 2023 saidvandeklundert
- **What we used:** its 22 test fixture pairs (`crates/jcc/tests/data/config_N.txt` and `config_N_set.txt`, at commit
  `d4574088266a100aafa37dfe79b85e478bfecec9`), as test data for the Junos plugin's display set. They are in
  `fixtures/public/junos/pairs/` unchanged, and cleaned up in `packages/platform-junos/tests/fixtures/display-set/`:
  public addresses moved into the documentation ranges, password hashes and keys replaced with placeholders, a host
  and site name replaced, and the expected files of config_8, 15 and 16 put in Juniper's documented `deactivate` order
  (that folder's README has the details). They are test data only and don't ship in the products.
- **NOTICE text:** none (MIT).

MIT License

Copyright (c) 2023 saidvandeklundert

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
