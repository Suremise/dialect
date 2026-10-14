- **Project:** NSIS (Nullsoft Scriptable Install System) 3.11, as Tauri's bundler downloads it
  (`nsis-3.11.zip`, SHA-1 EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D)
- **URL:** https://nsis.sourceforge.io
- **License:** Zlib (the zlib/libpng license). Copyright (C) 1999-2025 Contributors
- **What we used:** the desktop app's installer (`Dialect_<version>_x64-setup.exe`) is an NSIS installer: its stub, the
  zlib compression module (`bundle.windows.nsis.compression: "zlib"` in `apps/desktop/src-tauri/tauri.conf.json`), and
  the `System`, `nsDialogs`, `StartMenu` and `NSISdl` plug-ins. NSIS's bzip2 and LZMA modules (bzip2 license, CPL-1.0)
  aren't used.
- **NOTICE text:** none

From NSIS's COPYING:

```text
COPYRIGHT
---------

Copyright (C) 1999-2025 Contributors

More detailed copyright information can be found in the individual source code files.

APPLICABLE LICENSES
-------------------

* All NSIS source code, plug-ins, documentation, examples, header files and graphics, with the exception of the compression modules and where otherwise noted, are licensed under the zlib/libpng license.

* The zlib compression module for NSIS is licensed under the zlib/libpng license.

ZLIB/LIBPNG LICENSE
-------------------

This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.

Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:

      1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.

      2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.

      3. This notice may not be removed or altered from any source distribution.
```
