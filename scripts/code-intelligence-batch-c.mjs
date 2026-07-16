import { runLanguageBatch } from './code-intelligence-language-batch.mjs';

await runLanguageBatch({
  batch: 'C',
  languages: ['java', 'kotlin', 'csharp'],
  repositoryScopes: {
    cirepo_java_google_gson: 'gson/src/main/java/com/google/gson/reflect',
    cirepo_java_google_guava: 'guava/src/com/google/common/base/internal',
    cirepo_java_spring_projects_spring_petclinic: 'src/main/java/org/springframework/samples/petclinic/owner',
    cirepo_kotlin_android_nowinandroid: 'core/model/src/main/kotlin',
    cirepo_kotlin_kotlin_kotlinx_coroutines: 'kotlinx-coroutines-core/common/src/internal',
    cirepo_kotlin_ktorio_ktor: 'ktor-server/ktor-server-core/common/src/io/ktor/server/routing',
    cirepo_csharp_dotnet_aspnetcore: 'src/Http/Routing/src/Patterns',
    cirepo_csharp_dotnet_runtime: 'src/libraries/System.Text.Json/src/System/Text/Json/Nodes',
    cirepo_csharp_jamesnk_newtonsoft_json: 'Src/Newtonsoft.Json/Linq/JsonPath'
  },
  claimReason: 'Batch C measures reviewed Java, Kotlin, and C# truth. It does not change the public engine or claim competitor parity.'
});
