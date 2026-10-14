# Models from other platforms

Saved models, as another platform's parse gives them, for what an NX-OS parse can't produce: `<case>.model.json` is
the model (with `modelVersion`), `<case>.rendered.cfg` the NX-OS render expected from it, and `<case>.warnings.json` the
codes of the warnings the render must raise, in order. `phase2.test.ts` renders each and checks all three, and that
every field is accounted for.
