import { runLanguageBatch } from './code-intelligence-language-batch.mjs';

await runLanguageBatch({
  batch: 'D',
  languages: ['c', 'cpp', 'swift', 'dart'],
  repositoryScopes: {
    cirepo_c_antirez_kilo: '.',
    cirepo_c_curl_curl: 'lib',
    cirepo_c_libuv_libuv: 'src',
    cirepo_cpp_catchorg_catch2: 'src/Catch2',
    cirepo_cpp_fmtlib_fmt: 'src',
    cirepo_cpp_nlohmann_json: 'include/nlohmann/detail',
    cirepo_swift_alamofire_alamofire: 'Source/Core',
    cirepo_swift_apple_swift_nio: 'Sources/NIOCore',
    cirepo_swift_vapor_vapor: 'Sources/Vapor/Routing',
    cirepo_dart_dart_lang_http: 'pkgs/http/lib',
    cirepo_dart_dart_lang_shelf: 'pkgs/shelf_router/lib',
    cirepo_dart_flutter_samples: 'navigation_and_routing/lib'
  },
  claimReason: 'Batch D measures reviewed C, C++, Swift, and Dart truth. It does not change the public engine or claim competitor parity.'
});
