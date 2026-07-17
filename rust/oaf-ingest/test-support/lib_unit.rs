#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_route_decorator_only_applies_to_the_immediately_following_method() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-immediate-route-decorator-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let mut source = String::from("class Items {\n  @Get('/real')\n  real() {}\n");
        for index in 0..2_000 {
            source.push_str(&format!("  plain{index}() {{}}\n"));
        }
        source.push_str("}\n");
        fs::write(root.join("items.ts"), source).unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let handlers = report
            .code_facts
            .iter()
            .filter(|fact| fact.predicate == "HANDLES" && fact.object == "route:GET_real")
            .map(|fact| fact.subject.as_str())
            .collect::<Vec<_>>();
        assert_eq!(handlers, vec!["method:Items_real"]);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn python_route_decorator_ignores_docstring_examples() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-python-route-docstring-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("scaffold.py"),
            [
                "@setupmethod",
                "def route():",
                "    \"\"\"Example:",
                "        @app.route('/not-executable')",
                "        def index():",
                "            return 'example'",
                "    \"\"\"",
                "    return None",
            ]
            .join("\n"),
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        assert!(!report
            .facts
            .iter()
            .any(|fact| fact.predicate == "HANDLES"), "{:#?}", report.facts);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn python_framework_routes_require_structural_bindings() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-python-framework-routes-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("urls.py"),
            [
                "from django.urls import include, path",
                "def django_item(request, item_id):",
                "    return item_id",
                "urlpatterns = [",
                "    path('django/<int:item_id>/', django_item, name='django-item'),",
                "    path('nested/', include('other.urls'))",
                "]",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("app.py"),
            [
                "from fastapi import FastAPI",
                "from httpx import Client",
                "app = FastAPI()",
                "client = Client()",
                "@app.get('/bound/{item_id}')",
                "def bound_item(item_id):",
                "    return item_id",
                "@client.get('/not-a-route')",
                "def unbound_item():",
                "    return None",
            ]
            .join("\n"),
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        assert!(report.facts.iter().any(|fact| {
            fact.subject == "function:django_item"
                && fact.predicate == "HANDLES"
                && fact.object == "route:ANY_django_param_"
                && fact.notes.as_deref() == Some("oaf.ingest:route-django")
        }), "{:#?}", report.facts);
        assert!(report.facts.iter().any(|fact| {
            fact.subject == "route:ANY_django_param_"
                && fact.predicate == "HAS_PATH"
                && fact.object == "path=/django/:param/"
        }), "{:#?}", report.facts);
        assert!(!report.facts.iter().any(|fact| {
            fact.subject == "route:ANY_nested" || fact.object == "route:ANY_nested"
        }), "{:#?}", report.facts);
        assert!(report.facts.iter().any(|fact| {
            fact.subject == "function:bound_item"
                && fact.predicate == "HANDLES"
                && fact.object == "route:GET_bound_param"
                && fact.notes.as_deref() == Some("oaf.ingest:route-fastapi")
        }), "{:#?}", report.facts);
        assert!(!report.facts.iter().any(|fact| {
            fact.subject == "function:unbound_item" && fact.predicate == "HANDLES"
        }), "{:#?}", report.facts);
        assert!(!report.facts.iter().any(|fact| {
            fact.subject == "route:GET_not_a_route" || fact.object == "route:GET_not_a_route"
        }), "{:#?}", report.facts);

        fs::remove_dir_all(root).unwrap();
    }

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
    fn resolves_calls_to_sibling_functions_in_the_enclosing_scope() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-lexical-sibling-call-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("nested.ts"),
            [
                "function outer() {",
                "  function caller() { visitor(); }",
                "  function visitor() {}",
                "  caller();",
                "}",
            ]
            .join("\n"),
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();

        assert!(report.facts.iter().any(|fact| {
            fact.subject == "function:outer"
                && fact.predicate == "CALLS"
                && fact.object == "function:outer_caller"
                && fact.notes.as_deref() == Some("oaf.ingest:resolved-scoped-call")
        }));
        assert!(report.facts.iter().any(|fact| {
            fact.subject == "function:outer_caller"
                && fact.predicate == "CALLS"
                && fact.object == "function:outer_visitor"
                && fact.notes.as_deref() == Some("oaf.ingest:resolved-scoped-call")
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn javascript_extracts_and_resolves_member_assigned_functions() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-javascript-member-assignments-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("request.js"),
            [
                "const req = {};",
                "req.accepts = function () {};",
                "req.acceptsCharsets = function (...charsets) {",
                "  return req.accepts(charsets);",
                "};",
                "function accepts() {}",
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

        assert!(
            facts.contains(&(
                "module:request",
                "DEFINES",
                "method:req_accepts",
                Some("oaf.ingest:define-callable")
            )),
            "{facts:#?}"
        );
        assert!(facts.contains(&(
            "module:request",
            "DEFINES",
            "method:req_acceptsCharsets",
            Some("oaf.ingest:define-callable")
        )));
        assert!(facts.contains(&(
            "method:req_acceptsCharsets",
            "CALLS",
            "method:req_accepts",
            Some("oaf.ingest:typed-call-javascript")
        )));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn javascript_extracts_chained_express_routes() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-javascript-chained-routes-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("routes.js"),
            [
                "function getItem() {}",
                "function postItem() {}",
                "app.route('/items/:id').get(getItem).post(postItem);",
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

        for (method, handler) in [("GET", "function:getItem"), ("POST", "function:postItem")] {
            let route = format!("route:{method}_items_param");
            let method_value = format!("method={method}");
            assert!(facts.contains(&(
                route.as_str(),
                "IS_A",
                "Route",
                Some("oaf.ingest:route")
            )));
            assert!(facts.contains(&(
                route.as_str(),
                "HAS_METHOD",
                method_value.as_str(),
                Some("oaf.ingest:route-javascript")
            )));
            assert!(facts.contains(&(
                route.as_str(),
                "HAS_PATH",
                "path=/items/:param",
                Some("oaf.ingest:route-javascript")
            )));
            assert!(facts.contains(&(
                handler,
                "HANDLES",
                route.as_str(),
                Some("oaf.ingest:route-javascript")
            )));
        }

        fs::remove_dir_all(root).unwrap();
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
        )), "{calls:#?}");
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
    fn python_package_root_resolves_absolute_self_import() {
        let parent = std::env::temp_dir().join(format!(
            "oaf-ingest-python-package-root-{}",
            std::process::id()
        ));
        let root = parent.join("fastapi");
        let _ = fs::remove_dir_all(&parent);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("__init__.py"), "").unwrap();
        fs::write(root.join("routing.py"), "class Router:\n    pass\n").unwrap();
        fs::write(
            root.join("applications.py"),
            "from fastapi.routing import Router\n",
        )
        .unwrap();
        fs::write(
            root.join("broken.py"),
            "from fastapi.routing.missing import Missing\n",
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        assert!(report.facts.iter().any(|fact| {
            fact.subject == "module:applications"
                && fact.predicate == "IMPORTS"
                && fact.object == "module:routing"
                && fact.notes.as_deref() == Some("oaf.ingest:resolved-import")
        }));
        assert!(!report.facts.iter().any(|fact| {
            fact.subject == "module:broken"
                && fact.predicate == "IMPORTS"
                && fact.object == "module:routing"
                && fact.notes.as_deref() == Some("oaf.ingest:resolved-import")
        }));

        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn python_package_root_resolves_relative_dotted_import() {
        let parent = std::env::temp_dir().join(format!(
            "oaf-ingest-python-relative-import-{}",
            std::process::id()
        ));
        let root = parent.join("requests");
        let _ = fs::remove_dir_all(&parent);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("__init__.py"), "").unwrap();
        fs::write(root.join("compat.py"), "class OrderedDict:\n    pass\n").unwrap();
        fs::write(
            root.join("structures.py"),
            "from .compat import OrderedDict\n",
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        assert!(report.facts.iter().any(|fact| {
            fact.subject == "module:structures"
                && fact.predicate == "IMPORTS"
                && fact.object == "module:compat"
                && fact.notes.as_deref() == Some("oaf.ingest:resolved-import")
        }));

        fs::remove_dir_all(parent).unwrap();
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
    fn commonjs_module_assignment_exports_the_referenced_function() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-commonjs-assignment-export-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("fp")).unwrap();
        fs::write(
            root.join("fp/_baseConvert.js"),
            "function baseConvert(util, name, func, options) { return func; }\nmodule.exports = baseConvert;\n",
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        assert!(report.facts.iter().any(|fact| {
            fact.subject == "module:fp__baseConvert"
                && fact.predicate == "EXPORTS"
                && fact.object == "function:baseConvert"
                && fact.source == "workspace://fp/_baseConvert.js"
                && fact.notes.as_deref() == Some("oaf.ingest:resolved-export")
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
                "from fastapi import FastAPI",
                "app = FastAPI()",
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
        assert!(
            facts.contains(&("function:rust_item", "HANDLES", "route:GET_items_param")),
            "{facts:#?}"
        );

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
        assert!(
            facts.contains(&("function:actix_item", "HANDLES", "route:GET_actix_param")),
            "{facts:#?}"
        );
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

    #[test]
    fn build_configuration_makefile_target_sources_emit_evidence() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-makefile-target-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("main.c"), "int main(void) { return 0; }\n").unwrap();
        fs::write(
            root.join("Makefile"),
            "app: main.c\n\t$(CC) -o app main.c\n",
        )
        .unwrap();

        let options = IngestOptions::new(&root);
        let report = extract_repo(&options).unwrap();
        assert!(report.code_facts.iter().any(|fact| {
            fact.subject == "build_target:app"
                && fact.predicate == "DEPENDS_ON"
                && fact.object == "module:main"
                && fact.source == "workspace://Makefile"
                && fact.note == "oaf.ingest:makefile-c"
        }));
        assert!(report.code_facts.iter().any(|fact| {
            fact.subject == "function:main"
                && fact.predicate == "ENTRY_POINT"
                && fact.object == "build_target:app"
        }));
        assert!(discover_file_hashes(&options)
            .unwrap()
            .iter()
            .any(|file| file.source == "workspace://Makefile"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn build_configuration_cmake_expands_one_level_source_variables() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-cmake-source-variables-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.c"), "void a(void) {}\n").unwrap();
        fs::write(root.join("src/b.c"), "void b(void) {}\n").unwrap();
        fs::write(
            root.join("Makefile.inc"),
            "BASE = src/a.c\nCSOURCES = $(BASE)\n",
        )
        .unwrap();
        fs::write(
            root.join("CMakeLists.txt"),
            [
                "set(EXTRA src/b.c)",
                "list(APPEND CSOURCES ${EXTRA})",
                "add_library(app STATIC ${CSOURCES})",
            ]
            .join("\n"),
        )
        .unwrap();

        let options = IngestOptions::new(&root);
        let report = extract_repo(&options).unwrap();
        for module in ["module:src_a", "module:src_b"] {
            assert!(report.code_facts.iter().any(|fact| {
                fact.subject == "build_target:app"
                    && fact.predicate == "DEPENDS_ON"
                    && fact.object == module
                    && fact.source == "workspace://CMakeLists.txt"
                    && fact.note == "oaf.ingest:cmake-c"
            }));
        }
        let hashes = discover_file_hashes(&options).unwrap();
        for source in ["workspace://CMakeLists.txt", "workspace://Makefile.inc"] {
            assert!(hashes.iter().any(|file| file.source == source));
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_d_preserves_native_mobile_language_structure() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../evals/code-intelligence/fixtures/batch-d")
            .canonicalize()
            .unwrap();

        let c = extract_repo(&IngestOptions::new(root.join("c"))).unwrap();
        assert!(c.facts.iter().any(|fact| {
            fact.subject == "module:src_main"
                && fact.predicate == "IMPORTS"
                && fact.object == "module:include_item"
        }));
        assert!(c.facts.iter().any(|fact| {
            fact.subject == "function:main"
                && fact.predicate == "ENTRY_POINT"
                && fact.object == "build_target:items"
        }));
        assert!(!c.facts.iter().any(|fact| fact.predicate == "HANDLES"));

        let cpp = extract_repo(&IngestOptions::new(root.join("cpp"))).unwrap();
        assert!(cpp.facts.iter().any(|fact| {
            fact.subject == "namespace:demo"
                && fact.predicate == "DEFINES"
                && fact.object == "class:demo.ItemService"
        }));
        assert!(cpp.facts.iter().any(|fact| {
            fact.subject == "class:demo.ItemService"
                && fact.predicate == "EXTENDS"
                && fact.object == "class:demo.ItemLoader"
        }));
        for signature in ["find(string)", "find(long)"] {
            assert!(cpp.facts.iter().any(|fact| {
                fact.subject == "class:demo.ItemService"
                    && fact.predicate == "DEFINES"
                    && fact.object == format!("method:demo.ItemService.{signature}")
            }));
        }
        assert!(cpp.facts.iter().any(|fact| {
            fact.subject == "method:demo.ItemService.lookup(string)"
                && fact.predicate == "IS_A"
                && fact.object == "Method"
                && fact.source == "workspace://src/item_service.cpp"
        }), "{:#?}", cpp.facts.iter().filter(|fact| fact.subject.contains("lookup")).collect::<Vec<_>>());
        assert!(cpp.facts.iter().any(|fact| {
            fact.subject == "function:demo.load_item(ItemService,string)"
                && fact.predicate == "CALLS"
                && fact.object == "method:demo.ItemService.lookup(string)"
                && fact.notes.as_deref() == Some("oaf.ingest:typed-call-cpp")
        }), "{:#?}", cpp.facts.iter().filter(|fact| fact.predicate == "CALLS").collect::<Vec<_>>());
        assert!(cpp.facts.iter().any(|fact| {
            fact.subject == "function:demo.ambiguous(string)"
                && fact.predicate == "CALLS"
                && fact.object == "external_function:find"
        }));
        assert!(!cpp.facts.iter().any(|fact| fact.predicate == "HANDLES"));

        let swift = extract_repo(&IngestOptions::new(root.join("swift"))).unwrap();
        assert!(swift.facts.iter().any(|fact| {
            fact.subject == "class:ItemService"
                && fact.predicate == "IMPLEMENTS"
                && fact.object == "protocol:ItemLoading"
        }));
        assert!(swift.facts.iter().any(|fact| {
            fact.subject == "extension:ItemService"
                && fact.predicate == "EXTENDS_TYPE"
                && fact.object == "class:ItemService"
        }));
        assert!(swift.facts.iter().any(|fact| {
            fact.predicate == "HANDLES"
                && fact.object == "route:GET_items_param"
                && fact.notes.as_deref() == Some("oaf.ingest:route-vapor")
        }));

        let dart = extract_repo(&IngestOptions::new(root.join("dart"))).unwrap();
        assert!(dart.facts.iter().any(|fact| {
            fact.subject == "library:demo.item"
                && fact.predicate == "DEFINES"
                && fact.object == "class:demo.item.ItemService"
        }));
        assert!(dart.facts.iter().any(|fact| {
            fact.subject == "class:demo.item.ItemService"
                && fact.predicate == "MIXES_IN"
                && fact.object == "mixin:demo.item.ItemLogging"
        }));
        assert!(dart.facts.iter().any(|fact| {
            fact.subject == "module:lib_routes_part"
                && fact.predicate == "PART_OF"
                && fact.object == "module:lib_routes"
        }), "{:#?}", dart.facts.iter().filter(|fact| fact.predicate == "PART_OF").collect::<Vec<_>>());
        assert!(dart.facts.iter().any(|fact| {
            fact.predicate == "HANDLES"
                && fact.object == "route:GET_items_param"
                && fact.notes.as_deref() == Some("oaf.ingest:route-shelf")
        }));
        assert!(dart.facts.iter().any(|fact| {
            fact.subject == "function:main"
                && fact.predicate == "ENTRY_POINT"
                && fact.object == "framework:flutter_application"
        }));
    }

    #[test]
    fn batch_e_preserves_php_ruby_namespaces_mixins_typed_calls_and_routes() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../evals/code-intelligence/fixtures/batch-e")
            .canonicalize()
            .unwrap();

        let php = extract_repo(&IngestOptions::new(root.join("php"))).unwrap();
        assert!(php.facts.iter().any(|fact| {
            fact.subject == "namespace:App"
                && fact.predicate == "DEFINES"
                && fact.object == "class:App.ItemService"
        }));
        assert!(php.facts.iter().any(|fact| {
            fact.subject == "class:App.ItemService"
                && fact.predicate == "IMPLEMENTS"
                && fact.object == "interface:App.Contracts.ItemLoader"
        }), "{:#?}", php.facts.iter().filter(|fact| fact.predicate == "IMPLEMENTS").collect::<Vec<_>>());
        assert!(php.facts.iter().any(|fact| {
            fact.subject == "class:App.ItemService"
                && fact.predicate == "MIXES_IN"
                && fact.object == "trait:App.Support.LogsItems"
        }));
        assert!(php.facts.iter().any(|fact| {
            fact.subject == "function:App.describe"
                && fact.predicate == "CALLS"
                && fact.object == "method:App.ItemService_summary"
                && fact.notes.as_deref() == Some("oaf.ingest:typed-call-php")
        }), "{:#?}", php.facts.iter().filter(|fact| fact.predicate == "CALLS").collect::<Vec<_>>());
        assert!(php.facts.iter().any(|fact| {
            fact.subject == "method:App.Controller.ItemController_store"
                && fact.predicate == "HANDLES"
                && fact.object == "route:POST_items"
                && fact.notes.as_deref() == Some("oaf.ingest:route-laravel")
        }));
        assert!(php.facts.iter().any(|fact| {
            fact.subject == "method:App.Controller.ItemController_show"
                && fact.predicate == "HANDLES"
                && fact.object == "route:GET_items_param"
                && fact.notes.as_deref() == Some("oaf.ingest:route-symfony")
        }), "{:#?}", php.facts.iter().filter(|fact| fact.predicate == "HANDLES").collect::<Vec<_>>());

        let ruby = extract_repo(&IngestOptions::new(root.join("ruby"))).unwrap();
        assert!(ruby.facts.iter().any(|fact| {
            fact.subject == "namespace:Demo"
                && fact.predicate == "DEFINES"
                && fact.object == "class:Demo.ItemService"
        }));
        assert!(ruby.facts.iter().any(|fact| {
            fact.subject == "class:Demo.ItemService"
                && fact.predicate == "EXTENDS"
                && fact.object == "class:Demo.BaseService"
        }));
        assert!(ruby.facts.iter().any(|fact| {
            fact.subject == "class:Demo.ItemService"
                && fact.predicate == "MIXES_IN"
                && fact.object == "namespace:Demo.Logging"
        }));
        assert!(ruby.facts.iter().any(|fact| {
            fact.subject == "module:lib_demo_item_service"
                && fact.predicate == "IMPORTS"
                && fact.object == "module:lib_demo_item"
        }), "{:#?}", ruby.facts.iter().filter(|fact| fact.predicate == "IMPORTS").collect::<Vec<_>>());
        assert!(ruby.facts.iter().any(|fact| {
            fact.predicate == "CALLS"
                && fact.object == "method:Demo.ItemService_summary"
                && fact.notes.as_deref() == Some("oaf.ingest:typed-call-ruby")
        }), "{:#?}", ruby.facts.iter().filter(|fact| fact.predicate == "CALLS").collect::<Vec<_>>());
        for note in ["oaf.ingest:route-rails", "oaf.ingest:route-sinatra"] {
            assert!(ruby.facts.iter().any(|fact| {
                fact.predicate == "HANDLES" && fact.notes.as_deref() == Some(note)
            }), "missing {note}: {:#?}", ruby.facts.iter().filter(|fact| fact.predicate == "HANDLES").collect::<Vec<_>>());
        }
    }

    #[test]
    fn php_import_aliases_are_scoped_to_the_declaring_file() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-php-file-aliases-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/First.php"),
            [
                "<?php",
                "namespace Demo\\First;",
                "use Vendor\\One\\Contract as SharedContract;",
                "trait LocalTrait { public function execute() {} }",
                "class FirstService implements SharedContract {",
                "  use LocalTrait { execute as run; }",
                "  public function dispatch() { return $this->helper(); }",
                "  private function helper() { return true; }",
                "}",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("src/Second.php"),
            [
                "<?php",
                "namespace Demo\\Second;",
                "use Vendor\\Two\\Contract as SharedContract;",
                "class SecondService implements SharedContract {}",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("src/VendorOne.php"),
            "<?php\nnamespace Vendor\\One;\ninterface Contract {}\n",
        )
        .unwrap();
        fs::write(
            root.join("src/VendorTwo.php"),
            "<?php\nnamespace Vendor\\Two;\ninterface Contract {}\n",
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        assert!(report.facts.iter().any(|fact| {
            fact.subject == "class:Demo.First.FirstService"
                && fact.predicate == "IMPLEMENTS"
                && fact.object == "interface:Vendor.One.Contract"
        }), "{:#?}", report.facts.iter().filter(|fact| fact.predicate == "IMPLEMENTS").collect::<Vec<_>>());
        assert!(report.facts.iter().any(|fact| {
            fact.subject == "class:Demo.Second.SecondService"
                && fact.predicate == "IMPLEMENTS"
                && fact.object == "interface:Vendor.Two.Contract"
        }), "{:#?}", report.facts.iter().filter(|fact| fact.predicate == "IMPLEMENTS").collect::<Vec<_>>());
        let first_mixins = report
            .facts
            .iter()
            .filter(|fact| {
                fact.subject == "class:Demo.First.FirstService" && fact.predicate == "MIXES_IN"
            })
            .collect::<Vec<_>>();
        assert_eq!(first_mixins.len(), 1, "{first_mixins:#?}");
        assert_eq!(first_mixins[0].object, "trait:Demo.First.LocalTrait");
        assert!(report.facts.iter().any(|fact| {
            fact.subject == "method:Demo.First.FirstService_dispatch"
                && fact.predicate == "CALLS"
                && fact.object == "method:Demo.First.FirstService_helper"
                && fact.notes.as_deref() == Some("oaf.ingest:typed-call-php")
        }), "{:#?}", report.facts.iter().filter(|fact| fact.predicate == "CALLS").collect::<Vec<_>>());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ruby_include_predicates_are_not_reported_as_mixins() {
        let root = std::env::temp_dir().join(format!(
            "oaf-ingest-ruby-include-predicate-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("sample.rb"),
            [
                "module SharedBehavior",
                "end",
                "class Example",
                "  include SharedBehavior",
                "  def contains?(values)",
                "    values.include?(:item)",
                "  end",
                "end",
            ]
            .join("\n"),
        )
        .unwrap();

        let report = extract_repo(&IngestOptions::new(&root)).unwrap();
        let mixins = report
            .facts
            .iter()
            .filter(|fact| fact.predicate == "MIXES_IN")
            .collect::<Vec<_>>();
        assert_eq!(mixins.len(), 1, "{mixins:#?}");
        assert_eq!(mixins[0].subject, "class:Example");
        assert_eq!(mixins[0].object, "namespace:SharedBehavior");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_hash_diff_uses_content_and_detects_only_unambiguous_renames() {
        let hash = |source: &str, sha256: &str, bytes: u64| IngestFileHash {
            source: source.to_string(),
            sha256: sha256.repeat(64),
            bytes,
        };
        let previous = vec![
            hash("workspace://same.ts", "a", 100),
            hash("workspace://changed.ts", "b", 100),
            hash("workspace://old.ts", "c", 50),
            hash("workspace://deleted.ts", "d", 25),
        ];
        let current = vec![
            hash("workspace://same.ts", "a", 100),
            hash("workspace://changed.ts", "e", 100),
            hash("workspace://renamed.ts", "c", 50),
            hash("workspace://added.ts", "f", 10),
        ];

        let diff = diff_file_hashes(&previous, &current).unwrap();
        assert_eq!(diff.unchanged_count, 1);
        assert_eq!(
            diff.changed
                .iter()
                .map(|file| file.source.as_str())
                .collect::<Vec<_>>(),
            ["workspace://changed.ts"]
        );
        assert_eq!(diff.deleted, ["workspace://deleted.ts"]);
        assert_eq!(
            diff.added
                .iter()
                .map(|file| file.source.as_str())
                .collect::<Vec<_>>(),
            ["workspace://added.ts"]
        );
        assert_eq!(diff.renamed.len(), 1);
        assert_eq!(diff.renamed[0].from_source, "workspace://old.ts");
        assert_eq!(diff.renamed[0].to_source, "workspace://renamed.ts");
    }

    #[test]
    fn python_configuration_resources_are_package_keyed_and_causally_resolve_imports() {
        let scratch = std::env::temp_dir().join(format!(
            "oaf-ingest-python-configuration-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&scratch);
        let project = scratch.join("project");
        fs::create_dir_all(project.join("src/demo_app")).unwrap();
        fs::write(
            project.join("src/demo_app/base.py"),
            "class BaseService:\n    pass\n",
        )
        .unwrap();
        fs::write(
            project.join("src/demo_app/service.py"),
            "from demo_app.base import BaseService\nclass Service(BaseService):\n    pass\n",
        )
        .unwrap();

        let without_configuration = extract_repo(&IngestOptions::new(&project)).unwrap();
        assert!(!without_configuration.code_facts.iter().any(|fact| {
            fact.predicate == "IMPORTS"
                && fact.object == "module:src_demo_app_base"
                && fact.note == "oaf.ingest:resolved-import"
        }));
        assert!(without_configuration.code_facts.iter().any(|fact| {
            fact.predicate == "IMPORTS"
                && fact.source == "workspace://src/demo_app/service.py"
                && fact.note == "oaf.ingest:unresolved-import"
        }));

        fs::write(
            project.join("pyproject.toml"),
            "[project]\nname = \"demo-app\"\n",
        )
        .unwrap();
        let options = IngestOptions::new(&project);
        let with_configuration = extract_repo(&options).unwrap();
        assert!(with_configuration.code_facts.iter().any(|fact| {
            fact.subject == "module:src_demo_app_service"
                && fact.predicate == "IMPORTS"
                && fact.object == "module:src_demo_app_base"
                && fact.note == "oaf.ingest:resolved-import"
        }));
        for (subject, object) in [
            ("configuration_resource:demo_app", "ConfigurationResource"),
            ("package:demo_app", "Package"),
        ] {
            assert!(with_configuration.code_facts.iter().any(|fact| {
                fact.subject == subject
                    && fact.predicate == "IS_A"
                    && fact.object == object
                    && fact.source == "workspace://pyproject.toml"
                    && fact.note == "oaf.ingest:python-project-configuration"
                    && fact.span.start_line == 2
                    && fact.span.end_line == 2
            }));
        }
        assert!(with_configuration.code_facts.iter().any(|fact| {
            fact.subject == "configuration_resource:demo_app"
                && fact.predicate == "DEPENDS_ON"
                && fact.object == "package:demo_app"
                && fact.source == "workspace://pyproject.toml"
                && fact.note == "oaf.ingest:python-project-configuration"
                && fact.span.start_line == 2
                && fact.span.end_line == 2
        }));

        let mut source_bounded = IngestOptions::new(&project);
        source_bounded.only_sources = Some(
            [
                "workspace://src/demo_app/base.py".to_string(),
                "workspace://src/demo_app/service.py".to_string(),
            ]
            .into_iter()
            .collect(),
        );
        let source_bounded_report = extract_repo(&source_bounded).unwrap();
        assert!(!source_bounded_report.code_facts.iter().any(|fact| {
            fact.note == "oaf.ingest:python-project-configuration"
        }));

        assert!(discover_file_hashes(&options)
            .unwrap()
            .iter()
            .any(|file| file.source == "workspace://pyproject.toml"));
        let bounded = discover_file_hashes_bounded(
            &options,
            &FileHashDiscoveryBounds {
                max_candidate_files: 100,
                max_hashed_bytes: 10 * 1024 * 1024,
                selected_file_limit: None,
                deadline: Instant::now() + std::time::Duration::from_secs(5),
            },
            |_| true,
        )
        .unwrap();
        assert!(bounded.complete, "{:?}", bounded.reason_codes);
        assert!(bounded
            .hashes
            .iter()
            .any(|file| file.source == "workspace://pyproject.toml"));

        let scoped = scratch.join("fastapi");
        fs::create_dir_all(&scoped).unwrap();
        fs::write(
            scoped.join("__init__.py"),
            "from .routing import route\n__all__ = [\"route\"]\n",
        )
        .unwrap();
        fs::write(scoped.join("routing.py"), "def route():\n    pass\n").unwrap();
        let scoped_report = extract_repo(&IngestOptions::new(&scoped)).unwrap();
        for (subject, object) in [
            ("configuration_resource:fastapi", "ConfigurationResource"),
            ("package:fastapi", "Package"),
        ] {
            assert!(scoped_report.code_facts.iter().any(|fact| {
                fact.subject == subject
                    && fact.predicate == "IS_A"
                    && fact.object == object
                    && fact.source == "workspace://__init__.py"
                    && fact.note == "oaf.ingest:python-package-root-configuration"
                    && fact.span.start_line == 1
                    && fact.span.end_line == 2
            }));
        }
        assert!(scoped_report.code_facts.iter().any(|fact| {
            fact.subject == "configuration_resource:fastapi"
                && fact.predicate == "DEPENDS_ON"
                && fact.object == "package:fastapi"
                && fact.source == "workspace://__init__.py"
                && fact.note == "oaf.ingest:python-package-root-configuration"
                && fact.span.start_line == 1
                && fact.span.end_line == 2
        }));

        fs::write(scoped.join("__init__.py"), [0xff, b'\n']).unwrap();
        let non_utf8_marker = extract_repo(&IngestOptions::new(&scoped)).unwrap();
        assert!(non_utf8_marker.code_facts.iter().any(|fact| {
            fact.subject == "configuration_resource:fastapi"
                && fact.note == "oaf.ingest:python-package-root-configuration"
                && fact.span.start_line == 1
                && fact.span.end_line == 1
        }));

        fs::remove_dir_all(scratch).unwrap();
    }

}
