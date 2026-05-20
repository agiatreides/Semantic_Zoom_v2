# Third-Party Notices

This project does not vendor third-party source repositories. It depends on
published npm packages, an embedding model used by the corpus-generation tools,
and the checked-in source texts listed in `data/SOURCES.md`.

Package versions are pinned in `package-lock.json`.

## Direct Packages

| Package | Version | License | Use |
|---------|---------|---------|-----|
| `@chenglou/pretext` | 0.0.7 | MIT | Text measurement and line layout in `src/text-layout.js`. |
| `@huggingface/transformers` | 3.8.1 | Apache-2.0 | Local feature-extraction embeddings in `tools/generate-tree.js` and `tools/add-phrase-maps.js`. |
| `vite` | 6.4.2 | MIT | Development server and production build tooling. |

Project links:

- `@chenglou/pretext`: <https://github.com/chenglou/pretext>
- `@huggingface/transformers`: <https://github.com/huggingface/transformers.js>
- `vite`: <https://github.com/vitejs/vite>

## Embedding Model

The corpus-generation tools call Transformers.js with:

```js
pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })
```

Model:

- `Xenova/all-MiniLM-L6-v2`: <https://huggingface.co/Xenova/all-MiniLM-L6-v2>
- License: Apache-2.0, according to the Hugging Face model card.
- The model is downloaded by Transformers.js when generation tools run; model
  weights are not checked into this repository.

## Optional Transitive Packages

`@huggingface/transformers` depends on `sharp`, whose optional platform
packages include `libvips` binaries under `LGPL-3.0-or-later`. These optional
packages appear in `package-lock.json` for install reproducibility, but this
repository does not vendor or redistribute `node_modules`.

If you distribute a bundled artifact that includes third-party package code or
native binaries, include the corresponding package license files from that
artifact.

## Corpus Texts

Corpus source attribution and licenses are maintained in `data/SOURCES.md`.
The checked-in generated JSON files are derived from those adjacent source
texts and inherit their source text licenses.

Current corpus sources:

- Synthetic demo stories authored for this project: MIT.
- Ada Lovelace Wikipedia excerpt: Creative Commons Attribution-ShareAlike.
- FAIR Guiding Principles excerpt: Creative Commons Attribution 4.0.

## External Generation Tools

Generating new corpora can use a local `claude` CLI. The CLI and any connected
model service are not bundled with this repository, and no Anthropic source
code is included here.
