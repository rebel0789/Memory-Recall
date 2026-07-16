import { runLanguageBatch } from './code-intelligence-language-batch.mjs';

await runLanguageBatch({
  batch: 'B',
  languages: ['python', 'go', 'rust'],
  repositoryScopes: {
    cirepo_python_fastapi_fastapi: 'fastapi',
    cirepo_python_pallets_flask: 'src/flask',
    cirepo_python_psf_requests: 'src/requests',
    cirepo_go_gin_gonic_gin: '.',
    cirepo_go_go_chi_chi: '.',
    cirepo_go_hashicorp_go_multierror: '.',
    cirepo_rust_dtolnay_itoa: 'src',
    cirepo_rust_serde_rs_json: 'src',
    cirepo_rust_tokio_rs_axum: 'axum/src'
  },
  claimReason: 'Batch B measures reviewed Python, Go, and Rust truth. It does not change the public engine or claim competitor parity.'
});
