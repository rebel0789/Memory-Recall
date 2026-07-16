#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_calls_to_functions_not_modules() {
        let mut parsed = ParsedRepo::new();
        parsed.add_symbol_name("runServer", "function:runServer");
        assert_eq!(
            parsed.resolve_known_call_target("runServer").as_deref(),
            Some("function:runServer")
        );
        assert_eq!(parsed.resolve_known_call_target("missingModule"), None);
    }

    #[test]
    fn resolves_python_receiver_calls_with_constructor_type_bindings() {
        let root =
            std::env::temp_dir().join(format!("oaf-ingest-python-types-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/typed.py"),
            [
                "class Counter:",
                "    def inc(self):",
                "        return 1",
                "class Gauge:",
                "    def inc(self):",
                "        return 2",
                "def run():",
                "    counter = Counter()",
                "    gauge = Gauge()",
                "    counter.inc()",
                "    gauge.inc()",
            ]
            .join("\n"),
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let calls = report
            .facts
            .iter()
            .filter(|fact| fact.predicate == "CALLS")
            .map(|fact| {
                (
                    fact.subject.as_str(),
                    fact.object.as_str(),
                    fact.notes.as_deref(),
                )
            })
            .collect::<BTreeSet<_>>();

        assert!(calls.contains(&(
            "function:run",
            "method:Counter_inc",
            Some("oaf.ingest:typed-call-python")
        )));
        assert!(calls.contains(&(
            "function:run",
            "method:Gauge_inc",
            Some("oaf.ingest:typed-call-python")
        )));
        assert!(!calls.contains(&("function:run", "function:inc", Some("oaf.ingest:call"))));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn emits_routes_and_resolved_imports() {
        let root = std::env::temp_dir().join(format!("oaf-ingest-routes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/demo_app")).unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"name":"@acme/web","main":"src/index.js"}"#,
        )
        .unwrap();
        fs::write(
            root.join("pyproject.toml"),
            "[project]\nname = \"demo-app\"\n",
        )
        .unwrap();
        fs::write(
            root.join("src/index.js"),
            [
                "import { helper } from './helper.js';",
                "function listUsers(req, res) {",
                "  return helper();",
                "}",
                "app.get('/api/accounts/:id', listUsers);",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("src/helper.js"),
            "export function helper() { return 1; }\n",
        )
        .unwrap();
        fs::write(
            root.join("src/demo_app/app.py"),
            [
                "from flask import Flask",
                "app = Flask(__name__)",
                "@app.route('/items/<int:item_id>', methods=['POST'])",
                "def create_item():",
                "    return 'ok'",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("src/demo_app/client.py"),
            "from demo_app.app import create_item\n",
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let facts = report
            .facts
            .iter()
            .map(|fact| {
                (
                    fact.subject.as_str(),
                    fact.predicate.as_str(),
                    fact.object.as_str(),
                )
            })
            .collect::<BTreeSet<_>>();

        assert!(facts.contains(&("route:GET_api_accounts_param", "IS_A", "Route")));
        assert!(facts.contains(&(
            "route:GET_api_accounts_param",
            "HAS_PATH",
            "path=/api/accounts/:param"
        )));
        assert!(facts.contains(&(
            "function:listUsers",
            "HANDLES",
            "route:GET_api_accounts_param"
        )));
        assert!(facts.contains(&("route:POST_items_param", "IS_A", "Route")));
        assert!(facts.contains(&("function:create_item", "HANDLES", "route:POST_items_param")));
        assert!(facts.contains(&("module:src_index", "IMPORTS", "module:src_helper")));
        assert!(facts.contains(&(
            "module:src_demo_app_client",
            "IMPORTS",
            "module:src_demo_app_app"
        )));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn emits_exact_retirement_facts() {
        let active = vec![ActiveFactSnapshot {
            subject: "function:OldName".to_string(),
            predicate: "IS_A".to_string(),
            object: "Function".to_string(),
            source: "workspace://src/a.ts".to_string(),
        }];
        let retirements = retirement_facts(&active, &[]);
        assert_eq!(retirements.len(), 1);
        assert_eq!(retirements[0].subject, "function:OldName");
        assert_eq!(
            retirements[0]
                .supersedes
                .as_ref()
                .and_then(|item| item.object.as_deref()),
            Some("Function")
        );
    }

    #[test]
    fn parallel_extract_matches_sequential_fact_set() {
        let root = std::env::temp_dir().join(format!("oaf-ingest-parallel-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/a.js"),
            "export function alpha(){ return beta(); }\nfunction beta(){ return 1; }\n",
        )
        .unwrap();
        fs::write(
            root.join("src/b.py"),
            "def gamma():\n    return delta()\ndef delta():\n    return 1\n",
        )
        .unwrap();
        fs::write(
            root.join("src/c.rs"),
            "fn epsilon(){ zeta(); }\nfn zeta() {}\n",
        )
        .unwrap();

        let mut sequential = IngestOptions::new(&root);
        sequential.workers = 1;
        let mut parallel = IngestOptions::new(&root);
        parallel.workers = 4;

        let sequential = extract_repo(&sequential).unwrap();
        let parallel = extract_repo(&parallel).unwrap();
        assert_eq!(sequential.facts, parallel.facts);
        assert_eq!(sequential.scanned_file_count, parallel.scanned_file_count);
        assert_eq!(sequential.parsed_file_count, parallel.parsed_file_count);
        assert!(parallel.effective_worker_count >= 1);
        assert!(parallel.effective_worker_count <= 4);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovers_useful_facts_from_partially_parsed_typescript() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-typescript-recovery-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("recover.ts"),
            "const incomplete = ;\nexport function stillWorks() { return 1; }\n",
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        assert_eq!(report.parsed_file_count, 1);
        assert_eq!(report.skipped_file_count, 0);
        assert_eq!(report.recovered_files.len(), 1);
        assert!(report.facts.iter().any(|fact| {
            fact.subject == "function:stillWorks"
                && fact.predicate == "IS_A"
                && fact.object == "Function"
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn typescript_exports_and_generic_heritage_use_structural_fields() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-typescript-structural-fields-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("module.ts"),
            [
                "export class RouteModule<T> {}",
                "export type Userland = { userland: string };",
                "export interface Options extends Omit<RouteModule<Userland>, 'userland'> {}",
                "export class AppRoute extends RouteModule<Userland> {",
                "  /** Loaded from the 'userland' module. */",
                "  message = \"from source\";",
                "}",
            ]
            .join("\n"),
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let facts = report
            .facts
            .iter()
            .map(|fact| {
                (
                    fact.subject.as_str(),
                    fact.predicate.as_str(),
                    fact.object.as_str(),
                )
            })
            .collect::<BTreeSet<_>>();

        assert!(facts.contains(&("class:AppRoute", "EXTENDS", "class:RouteModule")));
        assert!(facts.contains(&("interface:Options", "EXTENDS", "external_class:Omit")));
        assert!(!facts.iter().any(|(_, predicate, object)| {
            *predicate == "RE_EXPORTS"
                || (*predicate == "EXTENDS"
                    && matches!(*object, "type_alias:Userland" | "method:userland"))
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn javascript_keeps_private_methods_and_member_call_resolution_scoped() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-javascript-member-calls-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("client.js"),
            [
                "class Helper { static run() { return 1; } }",
                "class Client {",
                "  request() { return this._request(); }",
                "  _request() { return Helper.run(); }",
                "}",
                "function resolve() { return 'local'; }",
                "function build() { return path.resolve('out'); }",
            ]
            .join("\n"),
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let facts = report
            .facts
            .iter()
            .map(|fact| {
                (
                    fact.subject.as_str(),
                    fact.predicate.as_str(),
                    fact.object.as_str(),
                    fact.notes.as_deref(),
                )
            })
            .collect::<BTreeSet<_>>();

        assert!(facts.contains(&(
            "class:Client",
            "DEFINES",
            "method:Client__request",
            Some("oaf.ingest:define-callable")
        )));
        assert!(
            facts.contains(&(
                "method:Client_request",
                "CALLS",
                "method:Client__request",
                Some("oaf.ingest:typed-call-javascript")
            )),
            "{facts:#?}"
        );
        assert!(facts.contains(&(
            "method:Client__request",
            "CALLS",
            "method:Helper_run",
            Some("oaf.ingest:typed-call-javascript")
        )));
        assert!(facts.contains(&(
            "function:build",
            "CALLS",
            "external_function:resolve",
            Some("oaf.ingest:unresolved-call")
        )));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn python_go_rust_batch_b_fixture_emits_typed_structure_and_routes() {
        let root =
            std::env::temp_dir().join(format!("oaf-ingest-batch-b-fixture-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("app.py"),
            [
                "class BaseService:",
                "    pass",
                "class Other:",
                "    def get_dict(self):",
                "        return {}",
                "class Lookup(dict[str, T]):",
                "    pass",
                "class Service(BaseService, Generic[T]):",
                "    def run(self):",
                "        return 1",
                "@app.get('/items/{item_id}')",
                "def python_item():",
                "    service = Service()",
                "    return service.run()",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("server.go"),
            [
                "package demo",
                "type Service struct{}",
                "func (s *Service) Run() {}",
                "func Use(s *Service) { s.Run() }",
                "func GoItem() {}",
                "func Register(router *Router) {",
                "  router.GET(\"/items/:item_id\", GoItem)",
                "}",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("server.rs"),
            [
                "trait Runner { fn run(&self); }",
                "struct Service;",
                "impl Service { fn new() -> Self { Service } }",
                "impl Runner for Service { fn run(&self) {} }",
                "fn use_service(service: &Service) { service.run(); }",
                "fn build() { Service::new(); }",
                "fn rust_item() {}",
                "fn router() { Router::new().route(\"/items/:item_id\", get(rust_item)); }",
            ]
            .join("\n"),
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let facts = report
            .facts
            .iter()
            .map(|fact| {
                (
                    fact.subject.as_str(),
                    fact.predicate.as_str(),
                    fact.object.as_str(),
                )
            })
            .collect::<BTreeSet<_>>();

        assert!(facts.contains(&("class:Service", "EXTENDS", "class:BaseService")));
        assert!(facts.contains(&("class:Service", "EXTENDS", "external_class:Generic")));
        assert!(!facts.contains(&("class:Service", "EXTENDS", "external_class:T")));
        assert!(facts.contains(&("class:Lookup", "EXTENDS", "external_class:dict")));
        assert!(!facts.contains(&("class:Lookup", "EXTENDS", "method:Other_get_dict")));
        assert!(facts.contains(&("function:Use", "CALLS", "method:Service_Run")));
        assert!(facts.contains(&("function:use_service", "CALLS", "method:Service_run")));
        assert!(facts.contains(&("function:build", "CONSTRUCTS", "struct:Service")));
        assert!(facts.contains(&("function:python_item", "HANDLES", "route:GET_items_param")));
        assert!(facts.contains(&("function:GoItem", "HANDLES", "route:GET_items_param")));
        assert!(
            facts.contains(&("struct:Service", "IMPLEMENTS", "trait:Runner")),
            "{facts:#?}"
        );
        assert!(facts.contains(&("function:rust_item", "HANDLES", "route:GET_items_param")));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn go_methods_keep_type_owners_and_selector_calls_are_not_declarations() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-go-method-owners-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("engine.go"),
            [
                "package engine",
                "import \"html/template\"",
                "type Error struct{}",
                "type Route struct{}",
                "type Routes interface { // structure is traversable",
                "    Routes() []Route",
                "}",
                "func New() *Error { return &Error{} }",
                "func (err *Error) Error() string { return \"\" }",
                "func (err *Error) Load() { template.New(\"\") }",
                "func (err *Error) rebuild() {}",
                "func (err *Error) NoRoute() { err.rebuild() }",
            ]
            .join("\n"),
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let facts = report
            .facts
            .iter()
            .map(|fact| {
                (
                    fact.subject.as_str(),
                    fact.predicate.as_str(),
                    fact.object.as_str(),
                    fact.notes.as_deref(),
                )
            })
            .collect::<BTreeSet<_>>();

        assert!(facts.contains(&(
            "interface:Routes",
            "IS_A",
            "Interface",
            Some("oaf.ingest:type")
        )));
        assert!(facts.contains(&(
            "struct:Error",
            "DEFINES",
            "method:Error_Load",
            Some("oaf.ingest:define-callable")
        )));
        assert!(facts.contains(&(
            "struct:Error",
            "DEFINES",
            "method:Error_NoRoute",
            Some("oaf.ingest:define-callable")
        )));
        assert!(facts.contains(&(
            "method:Error_NoRoute",
            "CALLS",
            "method:Error_rebuild",
            Some("oaf.ingest:typed-call-go")
        )));
        assert!(facts.contains(&(
            "function:New",
            "CONSTRUCTS",
            "struct:Error",
            Some("oaf.ingest:resolved-construct")
        )));
        assert!(!facts.iter().any(|(subject, predicate, _, _)| {
            *predicate == "IS_A" && subject.starts_with("function:") && subject.ends_with("_New")
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rust_generic_impl_methods_resolve_to_the_declared_type_owner() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-rust-generic-impl-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("map.rs"),
            [
                "struct Map<K, V> { entries: Vec<(K, V)> }",
                "impl<K, V> Map<K, V> {",
                "    fn new() -> Self { Self { entries: Vec::new() } }",
                "    fn clear(&mut self) { self.entries.clear(); }",
                "}",
                "impl<K, V> Default for Map<K, V> {",
                "    fn default() -> Self { Self::new() }",
                "}",
            ]
            .join("\n"),
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let facts = report
            .facts
            .iter()
            .map(|fact| {
                (
                    fact.subject.as_str(),
                    fact.predicate.as_str(),
                    fact.object.as_str(),
                    fact.notes.as_deref(),
                )
            })
            .collect::<BTreeSet<_>>();

        assert!(facts.contains(&(
            "struct:Map",
            "DEFINES",
            "method:Map_new",
            Some("oaf.ingest:define-callable")
        )));
        assert!(facts.contains(&(
            "struct:Map",
            "DEFINES",
            "method:Map_clear",
            Some("oaf.ingest:define-callable")
        )));
        assert!(facts.contains(&(
            "struct:Map",
            "DEFINES",
            "method:Map_default",
            Some("oaf.ingest:define-callable")
        )));
        assert!(facts.contains(&(
            "method:Map_default",
            "CONSTRUCTS",
            "struct:Map",
            Some("oaf.ingest:resolved-construct")
        )));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_c_fixtures_preserve_containers_overloads_typed_calls_and_routes() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../evals/code-intelligence/fixtures/batch-c")
            .canonicalize()
            .unwrap();
        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let facts = report
            .facts
            .iter()
            .map(|fact| {
                (
                    fact.subject.as_str(),
                    fact.predicate.as_str(),
                    fact.object.as_str(),
                    fact.notes.as_deref(),
                )
            })
            .collect::<BTreeSet<_>>();

        assert!(facts.contains(&(
            "package:com.acme.service",
            "DEFINES",
            "class:com.acme.service.ItemService",
            Some("oaf.ingest:define-type")
        )));
        assert!(facts.contains(&(
            "namespace:Demo.Services",
            "DEFINES",
            "class:Demo.Services.ItemService",
            Some("oaf.ingest:define-type")
        )));
        assert!(facts.contains(&(
            "class:com.acme.service.ItemService",
            "IMPLEMENTS",
            "interface:com.acme.service.ItemLoader",
            Some("oaf.ingest:resolved-heritage")
        )));
        assert!(facts.contains(&(
            "class:Demo.Services.ItemService",
            "IMPLEMENTS",
            "interface:Demo.Services.IItemLoader",
            Some("oaf.ingest:resolved-heritage")
        )));
        assert!(facts.iter().any(|(subject, predicate, object, _)| {
            *predicate == "DEFINES"
                && *subject == "class:com.acme.service.ItemService"
                && *object == "method:com.acme.service.ItemService.load(String)"
        }));
        assert!(facts.iter().any(|(subject, predicate, object, _)| {
            *predicate == "DEFINES"
                && *subject == "class:com.acme.service.ItemService"
                && *object == "method:com.acme.service.ItemService.load(long)"
        }));
        assert!(facts.contains(&(
            "method:com.acme.api.ItemController.get(String)",
            "CALLS",
            "method:com.acme.service.ItemService.find(String)",
            Some("oaf.ingest:typed-call-java")
        )));
        assert!(facts.contains(&(
            "method:Demo.Api.ItemsController.Get(string)",
            "CALLS",
            "method:Demo.Services.ItemService.Find(string)",
            Some("oaf.ingest:typed-call-csharp")
        )));
        assert!(facts.contains(&(
            "method:com.acme.api.ItemController.ambiguous(String)",
            "CALLS",
            "external_function:load",
            Some("oaf.ingest:unresolved-call")
        )));
        assert!(facts.contains(&(
            "method:Demo.Api.ItemsController.Ambiguous(string)",
            "CALLS",
            "external_function:Load",
            Some("oaf.ingest:unresolved-call")
        )));
        assert!(!facts.iter().any(|(subject, predicate, object, _)| {
            *predicate == "CALLS"
                && (*subject == "method:com.acme.api.ItemController.ambiguous(String)"
                    || *subject == "method:Demo.Api.ItemsController.Ambiguous(string)")
                && (object.ends_with("load(String)")
                    || object.ends_with("load(long)")
                    || object.ends_with("Load(string)")
                    || object.ends_with("Load(long)"))
        }));
        assert!(facts.contains(&(
            "method:com.acme.api.ItemController.get(String)",
            "HANDLES",
            "route:GET_items_param",
            Some("oaf.ingest:route-spring")
        )));
        assert!(facts.iter().any(|(subject, predicate, object, note)| {
            *predicate == "HANDLES"
                && *subject == "function:com.acme.api.itemRoutes(ItemService)"
                && *object == "route:GET_items_param"
                && *note == Some("oaf.ingest:route-ktor")
        }));
        assert!(facts.contains(&(
            "method:Demo.Api.ItemsController.Get(string)",
            "HANDLES",
            "route:GET_items_param",
            Some("oaf.ingest:route-aspnet-controller")
        )));
        assert!(facts.contains(&(
            "method:Demo.Api.Routes.Health()",
            "HANDLES",
            "route:GET_health",
            Some("oaf.ingest:route-aspnet-minimal")
        )));
    }

    #[test]
    fn batch_c_extension_calls_resolve_from_typed_receivers() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../evals/code-intelligence/fixtures/batch-c")
            .canonicalize()
            .unwrap();

        let kotlin = extract_repo(&IngestOptions::new(root.join("kotlin"))).unwrap();
        assert!(kotlin.facts.iter().any(|fact| {
            fact.subject == "function:com.acme.service.describe(Item)"
                && fact.predicate == "CALLS"
                && fact.object == "function:com.acme.service.summary()"
                && fact.notes.as_deref() == Some("oaf.ingest:typed-call-kotlin")
        }));
        assert!(!kotlin.facts.iter().any(|fact| {
            fact.predicate == "CALLS"
                && matches!(fact.object.as_str(), "external_function:id" | "external_function:routing")
        }));

        let csharp = extract_repo(&IngestOptions::new(root.join("csharp"))).unwrap();
        assert!(csharp.facts.iter().any(|fact| {
            fact.subject == "method:Demo.Api.ItemsController.Describe(Item)"
                && fact.predicate == "CALLS"
                && fact.object == "method:Demo.Services.ItemExtensions.Summary(Item)"
                && fact.notes.as_deref() == Some("oaf.ingest:typed-call-csharp")
        }));
    }

    #[test]
    fn batch_b_framework_routes_require_syntax_bound_handlers() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-batch-b-framework-routes-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("urls.py"),
            [
                "from django.urls import path",
                "def django_item(request, item_id):",
                "    return item_id",
                "urlpatterns = [path('/django/<int:item_id>', django_item)]",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("server.go"),
            [
                "package demo",
                "import \"net/http\"",
                "func netItem(w http.ResponseWriter, r *http.Request) {}",
                "func register() { http.HandleFunc(\"GET /net/{item_id}\", netItem) }",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("server.rs"),
            [
                "#[get(\"/rocket/<item_id>\")]",
                "fn rocket_item(item_id: u64) {}",
                "fn not_a_route() {}",
                "fn actix_item() {}",
                "fn app() { App::new().route(\"/actix/{item_id}\", web::get().to(actix_item)); }",
            ]
            .join("\n"),
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let facts = report
            .facts
            .iter()
            .map(|fact| {
                (
                    fact.subject.as_str(),
                    fact.predicate.as_str(),
                    fact.object.as_str(),
                )
            })
            .collect::<BTreeSet<_>>();

        assert!(facts.contains(&("function:django_item", "HANDLES", "route:ANY_django_param")));
        assert!(facts.contains(&("function:netItem", "HANDLES", "route:GET_net_param")));
        assert!(facts.contains(&("function:rocket_item", "HANDLES", "route:GET_rocket_param")));
        assert!(facts.contains(&("function:actix_item", "HANDLES", "route:GET_actix_param")));
        assert!(!facts.contains(&("function:not_a_route", "HANDLES", "route:GET_rocket_param")));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_b_manifests_resolve_go_and_rust_local_packages() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-batch-b-manifests-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("internal/service")).unwrap();
        fs::create_dir_all(root.join("cmd")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("go.mod"), "module example.com/demo\n").unwrap();
        fs::write(
            root.join("internal/service/service.go"),
            "package service\ntype Service struct{}\n",
        )
        .unwrap();
        fs::write(
            root.join("cmd/app.go"),
            [
                "package main",
                "import (",
                "  \"fmt\"",
                "  \"example.com/demo/internal/service\"",
                ")",
                "func main() { fmt.Println(service.Service{}) }",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"demo-crate\"\n",
        )
        .unwrap();
        fs::write(root.join("src/service.rs"), "pub struct Service;\n").unwrap();
        fs::write(
            root.join("src/lib.rs"),
            "mod service;\nuse crate::service::Service;\npub fn build() {}\n",
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let facts = report
            .facts
            .iter()
            .map(|fact| {
                (
                    fact.subject.as_str(),
                    fact.predicate.as_str(),
                    fact.object.as_str(),
                )
            })
            .collect::<BTreeSet<_>>();

        assert!(facts.contains(&(
            "module:cmd_app",
            "IMPORTS",
            "module:internal_service_service"
        )));
        assert!(facts.contains(&("function:main", "CONSTRUCTS", "struct:Service")));
        assert!(facts.contains(&("module:src_lib", "IMPORTS", "module:src_service")));
        assert_eq!(
            report
                .code_facts
                .iter()
                .filter(|fact| {
                    fact.predicate == "IMPORTS"
                        && fact.source == "workspace://cmd/app.go"
                        && fact.object == "module:internal_service_service"
                })
                .count(),
            1
        );

        fs::remove_dir_all(root).unwrap();
    }
}
