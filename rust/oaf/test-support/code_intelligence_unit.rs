#[cfg(test)]
mod tests {
    use super::*;
    use oaf_index::{
        normalized_generation_fingerprint, select_generation_files, DiscoveredFile,
        RefreshBounds, SourceIndex, SourceIndexOptions,
    };
    use std::fs;

    fn valid_request() -> Value {
        json!({
            "protocolVersion": "1.0.0",
            "requestId": "cireq_0123456789abcdef0123456789abcdef",
            "workspaceId": "ws_local",
            "operation": "graph.build",
            "root": ".",
            "deadlineMs": 30000,
            "responseSchemaVersion": "1.0.0",
            "arguments": {
                "maxFiles": 1000,
                "maxFileBytes": 524288,
                "maxNodes": 5000,
                "maxEdges": 10000,
                "languages": ["javascript", "typescript"]
            }
        })
    }

    #[test]
    fn request_parser_accepts_only_the_closed_relative_contract() {
        assert!(parse_request(&valid_request()).is_ok());
        let mut absolute = valid_request();
        absolute["root"] = Value::String("/private/tmp/repository".to_string());
        assert_eq!(
            parse_request(&absolute).unwrap_err().code,
            "engine_invalid_request"
        );
        let mut unknown = valid_request();
        unknown["sourceBody"] = Value::String("private".to_string());
        assert_eq!(
            parse_request(&unknown).unwrap_err().code,
            "engine_invalid_request"
        );
    }

    #[test]
    fn request_parser_separates_version_and_operation_errors() {
        let mut version = valid_request();
        version["protocolVersion"] = Value::String("2.0.0".to_string());
        assert_eq!(
            parse_request(&version).unwrap_err().code,
            "engine_unsupported_version"
        );
        let mut operation = valid_request();
        operation["operation"] = Value::String("workspace.write".to_string());
        assert_eq!(
            parse_request(&operation).unwrap_err().code,
            "engine_unsupported_operation"
        );
    }

    #[test]
    fn unresolved_notes_never_match_resolved_edge_mappings() {
        let fact = |predicate: &str, note: &str| CodeFactRecord {
            subject: "function:caller".to_string(),
            predicate: predicate.to_string(),
            object: "function:target".to_string(),
            source: "workspace://sample.ts".to_string(),
            note: note.to_string(),
            span: CodeSpan {
                start_line: 1,
                start_column: 0,
                end_line: 1,
                end_column: 1,
            },
        };

        assert_eq!(
            edge_mapping(&fact("IMPORTS", "oaf.ingest:unresolved-import"))
                .unwrap()
                .4,
            "unresolved"
        );
        assert_eq!(
            edge_mapping(&fact("RE_EXPORTS", "oaf.ingest:unresolved-re-export"))
                .unwrap()
                .4,
            "unresolved"
        );
        assert_eq!(
            edge_mapping(&fact("CONSTRUCTS", "oaf.ingest:unresolved-construct"))
                .unwrap()
                .4,
            "unresolved"
        );
        assert_eq!(
            edge_mapping(&fact("EXTENDS", "oaf.ingest:unresolved-heritage"))
                .unwrap()
                .4,
            "unresolved"
        );
    }

    #[test]
    fn canonical_names_disambiguate_same_line_symbols() {
        let node = |subject: &str, start_column: u32, end_column: u32| NativeNode {
            subject: subject.to_string(),
            source: "workspace://minified.js".to_string(),
            id: format!("node_{subject}"),
            kind: "function",
            language: "javascript".to_string(),
            name: "t".to_string(),
            qualified_name: "minified.js::t".to_string(),
            content_hash: None,
            span: CodeSpan {
                start_line: 1,
                start_column,
                end_line: 1,
                end_column,
            },
        };
        let mut nodes = vec![node("function:t_first", 10, 20), node("function:t_second", 30, 40)];

        disambiguate_qualified_names(&mut nodes);

        assert_eq!(nodes[0].qualified_name, "minified.js::t@L1C10");
        assert_eq!(nodes[1].qualified_name, "minified.js::t@L1C30");
    }

    #[test]
    fn javascript_typescript_graph_preserves_structure_resolution_and_spans() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-batch-a-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/util.ts"),
            [
                "export interface Service { run(): string }",
                "export class Greeter implements Service {",
                "  run(): string { return this.greet(); }",
                "  greet(): string { return 'hello'; }",
                "}",
                "export function helper(): string {",
                "  return 'ok';",
                "}",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("src/index.ts"),
            [
                "import { Greeter, helper } from './util';",
                "export function outer(): string {",
                "  const greeter = new Greeter();",
                "  function inner(): string {",
                "    return greeter.greet();",
                "  }",
                "  return helper() + inner();",
                "}",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("src/server.cjs"),
            [
                "const express = require('express');",
                "const app = express();",
                "function listUsers(req, res) { return res.json([]); }",
                "app.get('/users/:id', listUsers);",
                "http.createServer(listUsers);",
            ]
            .join("\n"),
        )
        .unwrap();

        let request = parse_request(&valid_request()).unwrap();
        let build = build_graph_at_root(&request, "test", &root, Instant::now());
        let graph = build.unwrap().graph;
        let nodes = graph["nodes"].as_array().unwrap();
        let edges = graph["edges"].as_array().unwrap();
        let helper = nodes
            .iter()
            .find(|node| node["name"] == "helper")
            .expect("helper function node");
        assert_eq!(helper["qualifiedName"], "src/util.ts::helper");
        assert_eq!(helper["locator"], "workspace://src/util.ts#L6-L8");
        assert!(nodes.iter().any(|node| {
            node["kind"] == "interface" && node["qualifiedName"] == "src/util.ts::Service"
        }));
        assert!(nodes.iter().any(|node| {
            node["kind"] == "function" && node["qualifiedName"] == "src/index.ts::outer::inner"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "imports"
                && edge["resolution"] == "exact"
                && edge["evidence"]["locator"] == "workspace://src/index.ts#L1-L1"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "constructs"
                && edge["resolution"] == "exact"
                && edge["evidence"]["locator"] == "workspace://src/index.ts#L3-L3"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "calls"
                && edge["resolution"] == "typed"
                && edge["evidence"]["locator"] == "workspace://src/index.ts#L5-L5"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "imports"
                && edge["evidence"]["locator"] == "workspace://src/server.cjs#L1-L1"
        }));
        assert!(edges.iter().any(|edge| edge["kind"] == "handles_route"));
        assert!(nodes.iter().any(|node| {
            node["kind"] == "framework_component" && node["name"] == "node_http_server"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "listens"
                && edge["evidence"]["locator"] == "workspace://src/server.cjs#L5-L5"
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn javascript_typescript_graph_covers_aliases_exports_heritage_and_server_routes() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-batch-a-frameworks-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/lib")).unwrap();
        fs::create_dir_all(root.join("app/api/users/[id]")).unwrap();
        fs::write(
            root.join("tsconfig.json"),
            r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["src/lib/*"]}}}"#,
        )
        .unwrap();
        fs::write(
            root.join("src/base.ts"),
            [
                "export interface Runnable { run(): string }",
                "export class BaseTask { run(): string { return 'base'; } }",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("src/lib/task.ts"),
            [
                "import { Runnable, BaseTask } from '../base';",
                "export type TaskId = string;",
                "export class Task extends BaseTask implements Runnable {",
                "  run(): string { return 'task'; }",
                "}",
                "export function execute(): string { return new Task().run(); }",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("src/index.ts"),
            [
                "import { execute } from '@lib/task';",
                "export { execute } from '@lib/task';",
                "fastify.get('/tasks/:id', execute);",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("app/api/users/[id]/route.ts"),
            "export async function GET() { return Response.json({ ok: true }); }\n",
        )
        .unwrap();

        let request = parse_request(&valid_request()).unwrap();
        let graph = build_graph_at_root(&request, "test", &root, Instant::now())
            .unwrap()
            .graph;
        let nodes = graph["nodes"].as_array().unwrap();
        let edges = graph["edges"].as_array().unwrap();

        assert!(nodes.iter().any(|node| {
            node["kind"] == "type_alias" && node["qualifiedName"] == "src/lib/task.ts::TaskId"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "imports"
                && edge["resolution"] == "exact"
                && edge["evidence"]["locator"] == "workspace://src/index.ts#L1-L1"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "re_exports"
                && edge["resolution"] == "exact"
                && edge["evidence"]["locator"] == "workspace://src/index.ts#L2-L2"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "exports"
                && edge["resolution"] == "exact"
                && edge["evidence"]["locator"] == "workspace://src/lib/task.ts#L2-L2"
        }));
        assert!(edges
            .iter()
            .any(|edge| edge["kind"] == "extends" && edge["resolution"] == "exact"));
        assert!(edges
            .iter()
            .any(|edge| edge["kind"] == "implements" && edge["resolution"] == "exact"));
        assert!(nodes
            .iter()
            .any(|node| node["kind"] == "route" && node["name"] == "GET_tasks_param"));
        assert!(nodes
            .iter()
            .any(|node| node["kind"] == "route" && node["name"] == "GET_api_users_param"));
        assert!(
            edges
                .iter()
                .filter(|edge| edge["kind"] == "handles_route")
                .count()
                >= 2
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn typescript_graph_extracts_nestjs_controller_routes() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-batch-a-nestjs-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/cats.controller.ts"),
            [
                "@Controller('/cats')",
                "export class CatsController {",
                "  @Get('/:id')",
                "  findOne(): string { return externalLookup(); }",
                "}",
            ]
            .join("\n"),
        )
        .unwrap();

        let request = parse_request(&valid_request()).unwrap();
        let graph = build_graph_at_root(&request, "test", &root, Instant::now())
            .unwrap()
            .graph;
        let nodes = graph["nodes"].as_array().unwrap();
        let edges = graph["edges"].as_array().unwrap();

        assert!(nodes
            .iter()
            .any(|node| { node["kind"] == "route" && node["name"] == "GET_cats_param" }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "handles_route"
                && edge["evidence"]["locator"] == "workspace://src/cats.controller.ts#L3-L4"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "calls"
                && edge["resolution"] == "unresolved"
                && edge["evidence"]["locator"] == "workspace://src/cats.controller.ts#L4-L4"
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn python_go_rust_graph_preserves_owners_routes_and_exact_resolution() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-batch-b-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("app.py"),
            [
                "class BaseService:",
                "    pass",
                "class Service(BaseService):",
                "    def run(self):",
                "        return 1",
                "@app.get('/python/{item_id}')",
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
                "type GoService struct{}",
                "func (s *GoService) Run() {}",
                "func goItem() {}",
                "func Register(router *Router) {",
                "  router.GET(\"/go/:item_id\", goItem)",
                "}",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            root.join("server.rs"),
            [
                "trait Runner { fn run(&self); }",
                "struct RustService;",
                "impl Runner for RustService { fn run(&self) {} }",
                "fn rust_item() {}",
                "fn router() { Router::new().route(\"/rust/:item_id\", get(rust_item)); }",
            ]
            .join("\n"),
        )
        .unwrap();

        let mut request_value = valid_request();
        request_value["arguments"]["languages"] = json!(["python", "go", "rust"]);
        let request = parse_request(&request_value).unwrap();
        let graph = build_graph_at_root(&request, "test", &root, Instant::now())
            .unwrap()
            .graph;
        let nodes = graph["nodes"].as_array().unwrap();
        let edges = graph["edges"].as_array().unwrap();

        assert!(
            nodes.iter().any(|node| {
                node["kind"] == "method" && node["qualifiedName"] == "app.py::Service::run"
            }),
            "{nodes:#?}"
        );
        assert!(nodes.iter().any(|node| {
            node["kind"] == "method" && node["qualifiedName"] == "server.go::GoService::Run"
        }));
        assert!(nodes.iter().any(|node| {
            node["kind"] == "method" && node["qualifiedName"] == "server.rs::RustService::run"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "constructs"
                && edge["resolution"] == "exact"
                && edge["evidence"]["locator"] == "workspace://app.py#L8-L8"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "calls"
                && edge["resolution"] == "typed"
                && edge["evidence"]["locator"] == "workspace://app.py#L9-L9"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "extends"
                && edge["resolution"] == "exact"
                && edge["evidence"]["locator"] == "workspace://app.py#L3-L5"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "implements"
                && edge["resolution"] == "exact"
                && edge["evidence"]["locator"] == "workspace://server.rs#L3-L3"
        }));
        for locator in [
            "workspace://app.py#L6-L9",
            "workspace://server.go#L6-L6",
            "workspace://server.rs#L5-L5",
        ] {
            assert!(edges.iter().any(|edge| {
                edge["kind"] == "handles_route" && edge["evidence"]["locator"] == locator
            }));
        }
        assert!(!edges.iter().any(|edge| {
            edge["kind"] == "calls"
                && matches!(
                    edge["evidence"]["locator"].as_str(),
                    Some("workspace://server.go#L6-L6" | "workspace://server.rs#L5-L5")
                )
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_python_callables_keep_owner_qualified_identities() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-python-nested-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("nested.py"),
            [
                "class Service:",
                "    def first(self):",
                "        def helper():",
                "            return 1",
                "        return helper()",
                "    def second(self):",
                "        def helper():",
                "            return 2",
                "        return helper()",
            ]
            .join("\n"),
        )
        .unwrap();

        let mut request_value = valid_request();
        request_value["arguments"]["languages"] = json!(["python"]);
        let request = parse_request(&request_value).unwrap();
        let graph = build_graph_at_root(&request, "test", &root, Instant::now())
            .unwrap()
            .graph;
        let nodes = graph["nodes"].as_array().unwrap();

        assert!(nodes.iter().any(|node| {
            node["kind"] == "function"
                && node["qualifiedName"] == "nested.py::Service::first::helper"
                && node["locator"] == "workspace://nested.py#L3-L4"
        }));
        assert!(nodes.iter().any(|node| {
            node["kind"] == "function"
                && node["qualifiedName"] == "nested.py::Service::second::helper"
                && node["locator"] == "workspace://nested.py#L7-L8"
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_c_native_graph_preserves_packages_overloads_typed_calls_and_routes() {
        let fixture_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../evals/code-intelligence/fixtures/batch-c")
            .canonicalize()
            .unwrap();

        for (language, relative_root) in [
            ("java", "java"),
            ("kotlin", "kotlin"),
            ("csharp", "csharp"),
        ] {
            let mut request_value = valid_request();
            request_value["arguments"]["languages"] = json!([language]);
            let request = parse_request(&request_value).unwrap();
            let graph = build_graph_at_root(
                &request,
                "test",
                &fixture_root.join(relative_root),
                Instant::now(),
            )
            .unwrap()
            .graph;
            let nodes = graph["nodes"].as_array().unwrap();
            let edges = graph["edges"].as_array().unwrap();

            let expected_container = match language {
                "csharp" => ("namespace", "Demo.Services"),
                _ => ("package", "com.acme.service"),
            };
            assert!(nodes.iter().any(|node| {
                node["kind"] == expected_container.0 && node["name"] == expected_container.1
            }));

            let (service_suffix, method_name, typed_locator, route_locator) = match language {
                "java" => (
                    "::com.acme.service::ItemService",
                    "find(String)",
                    "workspace://src/main/java/com/acme/api/ItemController.java#L20-L20",
                    "workspace://src/main/java/com/acme/api/ItemController.java#L18-L21",
                ),
                "kotlin" => (
                    "::com.acme.service::ItemService",
                    "find(String)",
                    "workspace://src/main/kotlin/com/acme/api/Routes.kt#L12-L12",
                    "workspace://src/main/kotlin/com/acme/api/Routes.kt#L11-L11",
                ),
                "csharp" => (
                    "::Demo.Services::ItemService",
                    "Find(string)",
                    "workspace://src/Demo/Api.cs#L19-L19",
                    "workspace://src/Demo/Api.cs#L18-L19",
                ),
                _ => unreachable!(),
            };
            let service_id = nodes
                .iter()
                .find(|node| {
                    node["kind"] == "class"
                        && node["qualifiedName"]
                            .as_str()
                            .is_some_and(|name| name.ends_with(service_suffix))
                })
                .and_then(|node| node["id"].as_str())
                .unwrap();
            let method_id = nodes
                .iter()
                .find(|node| {
                    node["kind"] == "method"
                        && node["name"] == method_name
                        && node["qualifiedName"]
                            .as_str()
                            .is_some_and(|name| name.contains("::ItemService::"))
                })
                .and_then(|node| node["id"].as_str())
                .unwrap();

            assert!(edges.iter().any(|edge| {
                edge["kind"] == "defines"
                    && edge["fromNodeId"] == service_id
                    && edge["toNodeId"] == method_id
            }), "{language}: service method definition edge missing");
            assert!(edges.iter().any(|edge| {
                edge["kind"] == "implements"
                    && edge["fromNodeId"] == service_id
                    && edge["resolution"] == "exact"
            }));
            assert!(edges.iter().any(|edge| {
                edge["kind"] == "calls"
                    && edge["toNodeId"] == method_id
                    && edge["resolution"] == "typed"
                    && edge["evidence"]["locator"] == typed_locator
            }), "{language}: expected typed target={method_id} locator={typed_locator}; calls={:#?}", edges.iter().filter(|edge| edge["kind"] == "calls").collect::<Vec<_>>());
            assert!(edges.iter().any(|edge| {
                edge["kind"] == "handles_route"
                    && edge["evidence"]["locator"] == route_locator
            }), "{language}: expected route locator {route_locator}; routes={:#?}", edges.iter().filter(|edge| edge["kind"] == "handles_route").collect::<Vec<_>>());

            let overload_names = match language {
                "java" => ["load(String)", "load(long)"],
                "kotlin" => ["load(String)", "load(Long)"],
                "csharp" => ["Load(string)", "Load(long)"],
                _ => unreachable!(),
            };
            for overload_name in overload_names {
                assert!(nodes.iter().any(|node| {
                    node["kind"] == "method"
                        && node["name"] == overload_name
                        && node["qualifiedName"]
                            .as_str()
                            .is_some_and(|name| name.contains("::ItemService::"))
                }));
            }

            if language != "java" {
                let (extension_kind, extension_name) = match language {
                    "kotlin" => ("function", "summary()"),
                    "csharp" => ("method", "Summary(Item)"),
                    _ => unreachable!(),
                };
                let extension_id = nodes
                    .iter()
                    .find(|node| {
                        node["kind"] == extension_kind && node["name"] == extension_name
                    })
                    .and_then(|node| node["id"].as_str())
                    .unwrap();
                assert!(edges.iter().any(|edge| {
                    edge["kind"] == "calls"
                        && edge["toNodeId"] == extension_id
                        && edge["resolution"] == "typed"
                }));
            }
        }
    }

    #[test]
    fn batch_d_native_graph_preserves_entry_points_extensions_mixins_and_parts() {
        let fixture_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../evals/code-intelligence/fixtures/batch-d")
            .canonicalize()
            .unwrap();

        for language in ["c", "cpp", "swift", "dart"] {
            let mut request_value = valid_request();
            request_value["arguments"]["languages"] = json!([language]);
            request_value["arguments"]["maxNodes"] = json!(1_000);
            request_value["arguments"]["maxEdges"] = json!(2_000);
            let request = parse_request(&request_value).unwrap();
            let graph = build_graph_at_root(
                &request,
                "test",
                &fixture_root.join(language),
                Instant::now(),
            )
            .unwrap()
            .graph;
            let nodes = graph["nodes"].as_array().unwrap();
            let edges = graph["edges"].as_array().unwrap();

            match language {
                "c" => {
                    let target = nodes
                        .iter()
                        .find(|node| node["kind"] == "build_target" && node["name"] == "items")
                        .and_then(|node| node["id"].as_str())
                        .unwrap();
                    assert!(edges.iter().any(|edge| {
                        edge["kind"] == "entry_point" && edge["toNodeId"] == target
                    }));
                    assert!(!edges.iter().any(|edge| edge["kind"] == "handles_route"));
                }
                "cpp" => {
                    assert!(nodes.iter().any(|node| {
                        node["kind"] == "namespace" && node["name"] == "demo"
                    }));
                    let lookup = nodes
                        .iter()
                        .find(|node| {
                            node["kind"] == "method"
                                && node["name"] == "lookup(string)"
                                && node["locator"]
                                    == "workspace://src/item_service.cpp#L4-L4"
                        })
                        .and_then(|node| node["id"].as_str())
                        .unwrap_or_else(|| {
                            panic!(
                                "{:#?}",
                                nodes
                                    .iter()
                                    .filter(|node| {
                                        node["qualifiedName"]
                                            .as_str()
                                            .is_some_and(|name| name.contains("lookup"))
                                    })
                                    .collect::<Vec<_>>()
                            )
                        });
                    assert!(edges.iter().any(|edge| {
                        edge["kind"] == "calls"
                            && edge["toNodeId"] == lookup
                            && edge["resolution"] == "typed"
                    }));
                    assert!(!edges.iter().any(|edge| edge["kind"] == "handles_route"));
                }
                "swift" => {
                    assert!(nodes.iter().any(|node| {
                        node["kind"] == "extension" && node["name"] == "ItemService"
                    }));
                    assert!(edges.iter().any(|edge| edge["kind"] == "extends_type"));
                    assert!(edges.iter().any(|edge| edge["kind"] == "implements"));
                    assert!(edges.iter().any(|edge| {
                        edge["kind"] == "handles_route"
                            && edge["evidence"]["locator"]
                                == "workspace://Sources/App/routes.swift#L4-L6"
                    }));
                }
                "dart" => {
                    for kind in ["library", "mixin", "extension"] {
                        assert!(nodes.iter().any(|node| node["kind"] == kind), "{kind}");
                    }
                    assert!(edges.iter().any(|edge| edge["kind"] == "mixes_in"));
                    assert!(edges.iter().any(|edge| edge["kind"] == "part_of"));
                    assert!(edges.iter().any(|edge| edge["kind"] == "entry_point"));
                    assert!(edges.iter().any(|edge| edge["kind"] == "handles_route"));
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn combined_c_cpp_cmake_entry_points_resolve_to_same_language_main() {
        let fixture_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../evals/code-intelligence/fixtures/batch-d")
            .canonicalize()
            .unwrap();
        let mut request_value = valid_request();
        request_value["arguments"]["languages"] = json!(["c", "cpp"]);
        request_value["arguments"]["maxNodes"] = json!(1_000);
        request_value["arguments"]["maxEdges"] = json!(2_000);
        let request = parse_request(&request_value).unwrap();
        let graph = build_graph_at_root(&request, "test", &fixture_root, Instant::now())
            .unwrap()
            .graph;
        let nodes = graph["nodes"].as_array().unwrap();
        let edges = graph["edges"].as_array().unwrap();
        let node_id = |kind: &str, name: &str, locator: &str| {
            nodes
                .iter()
                .find(|node| {
                    node["kind"] == kind && node["name"] == name && node["locator"] == locator
                })
                .and_then(|node| node["id"].as_str())
                .unwrap_or_else(|| panic!("missing {kind} {name} at {locator}"))
                .to_string()
        };
        let c_main = node_id("function", "main", "workspace://c/src/main.c#L3-L6");
        let cpp_main = node_id("function", "main", "workspace://cpp/src/main.cpp#L3-L6");
        let c_target = node_id(
            "build_target",
            "items",
            "workspace://c/CMakeLists.txt#L3-L3",
        );
        let cpp_target = node_id(
            "build_target",
            "items_cpp",
            "workspace://cpp/CMakeLists.txt#L3-L3",
        );
        let has_entry_point = |from: &str, to: &str| {
            edges.iter().any(|edge| {
                edge["kind"] == "entry_point"
                    && edge["fromNodeId"] == from
                    && edge["toNodeId"] == to
            })
        };

        assert!(has_entry_point(&c_main, &c_target));
        assert!(has_entry_point(&cpp_main, &cpp_target));
        assert!(!has_entry_point(&c_main, &cpp_target));
        assert!(!has_entry_point(&cpp_main, &c_target));
    }

    #[test]
    fn batch_e_native_graph_preserves_dynamic_language_structure_and_confidence() {
        let fixture_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../evals/code-intelligence/fixtures/batch-e")
            .canonicalize()
            .unwrap();

        for language in ["php", "ruby"] {
            let mut request_value = valid_request();
            request_value["arguments"]["languages"] = json!([language]);
            request_value["arguments"]["maxNodes"] = json!(1_000);
            request_value["arguments"]["maxEdges"] = json!(2_000);
            let request = parse_request(&request_value).unwrap();
            let graph = build_graph_at_root(
                &request,
                "test",
                &fixture_root.join(language),
                Instant::now(),
            )
            .unwrap()
            .graph;
            let nodes = graph["nodes"].as_array().unwrap();
            let edges = graph["edges"].as_array().unwrap();

            assert!(nodes.iter().any(|node| {
                node["kind"] == "namespace" && node["name"] == if language == "php" { "App" } else { "Demo" }
            }));
            let service = nodes
                .iter()
                .find(|node| node["kind"] == "class" && node["name"] == "ItemService")
                .and_then(|node| node["id"].as_str())
                .unwrap();
            let summary = nodes
                .iter()
                .find(|node| node["kind"] == "method" && node["name"] == "summary")
                .and_then(|node| node["id"].as_str())
                .unwrap();
            assert!(edges.iter().any(|edge| {
                edge["kind"] == "calls"
                    && edge["toNodeId"] == summary
                    && edge["resolution"] == "typed"
            }));
            assert!(edges.iter().any(|edge| {
                edge["kind"] == "mixes_in" && edge["fromNodeId"] == service
            }));
            assert!(edges.iter().filter(|edge| edge["kind"] == "handles_route").count() >= 2);

            if language == "php" {
                assert!(nodes.iter().any(|node| node["kind"] == "trait" && node["name"] == "LogsItems"));
                assert!(edges.iter().any(|edge| edge["kind"] == "implements" && edge["fromNodeId"] == service));
            } else {
                assert!(edges.iter().any(|edge| edge["kind"] == "imports" && edge["resolution"] == "exact"));
                assert!(edges.iter().any(|edge| edge["kind"] == "extends" && edge["fromNodeId"] == service));
            }
        }
    }

    #[test]
    fn cpp_requests_parse_ambiguous_dot_h_headers_as_cpp() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-cpp-header-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("legacy.h"),
            "namespace demo { class HeaderOnly { public: void run(); }; }\n",
        )
        .unwrap();
        fs::write(root.join("main.cpp"), "#include \"legacy.h\"\nint main() { return 0; }\n")
            .unwrap();

        let mut request_value = valid_request();
        request_value["arguments"]["languages"] = json!(["cpp"]);
        let request = parse_request(&request_value).unwrap();
        let graph = build_graph_at_root(&request, "test", &root, Instant::now())
            .unwrap()
            .graph;

        assert!(graph["nodes"].as_array().unwrap().iter().any(|node| {
            node["kind"] == "class"
                && node["language"] == "cpp"
                && node["qualifiedName"] == "legacy.h::demo::HeaderOnly"
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn swift_structs_and_enums_keep_their_native_kinds() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-swift-kinds-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("Models.swift"),
            "public struct Packet { public let id: Int }\npublic enum State { case ready }\n",
        )
        .unwrap();

        let mut request_value = valid_request();
        request_value["arguments"]["languages"] = json!(["swift"]);
        let request = parse_request(&request_value).unwrap();
        let graph = build_graph_at_root(&request, "test", &root, Instant::now())
            .unwrap()
            .graph;
        let nodes = graph["nodes"].as_array().unwrap();

        assert!(nodes.iter().any(|node| {
            node["kind"] == "struct" && node["qualifiedName"] == "Models.swift::Packet"
        }));
        assert!(nodes.iter().any(|node| {
            node["kind"] == "enum" && node["qualifiedName"] == "Models.swift::State"
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edge_budgets_keep_structural_evidence_before_unresolved_calls() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-edge-priority-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("main.c"),
            "int helper(void) { return 1; }\nint main(void) { a(); b(); c(); d(); e(); f(); return helper(); }\n",
        )
        .unwrap();

        let mut request_value = valid_request();
        request_value["arguments"]["languages"] = json!(["c"]);
        request_value["arguments"]["maxEdges"] = json!(3);
        let request = parse_request(&request_value).unwrap();
        let graph = build_graph_at_root(&request, "test", &root, Instant::now())
            .unwrap()
            .graph;
        let nodes = graph["nodes"].as_array().unwrap();
        let main_id = nodes
            .iter()
            .find(|node| node["kind"] == "function" && node["name"] == "main")
            .and_then(|node| node["id"].as_str())
            .unwrap();

        assert!(graph["edges"].as_array().unwrap().iter().any(|edge| {
            edge["kind"] == "defines" && edge["toNodeId"] == main_id
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn go_type_and_same_named_method_keep_distinct_graph_identities() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-go-same-name-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("error.go"),
            [
                "package sample",
                "type Error struct{}",
                "type Route struct{}",
                "type Routes interface { // structure is traversable",
                "    Routes() []Route",
                "}",
                "func New() *Error { return &Error{} }",
                "func (err *Error) Error() string { return \"\" }",
                "func (err *Error) ErrorOrNil() error { return err }",
            ]
            .join("\n"),
        )
        .unwrap();

        let mut request_value = valid_request();
        request_value["arguments"]["languages"] = json!(["go"]);
        let request = parse_request(&request_value).unwrap();
        let graph = build_graph_at_root(&request, "test", &root, Instant::now())
            .unwrap()
            .graph;
        let nodes = graph["nodes"].as_array().unwrap();
        let edges = graph["edges"].as_array().unwrap();
        let error_id = nodes
            .iter()
            .find(|node| node["kind"] == "struct" && node["qualifiedName"] == "error.go::Error")
            .and_then(|node| node["id"].as_str())
            .unwrap();
        let new_id = nodes
            .iter()
            .find(|node| node["kind"] == "function" && node["qualifiedName"] == "error.go::New")
            .and_then(|node| node["id"].as_str())
            .unwrap();

        assert!(nodes.iter().any(|node| {
            node["kind"] == "interface" && node["qualifiedName"] == "error.go::Routes"
        }));
        assert!(nodes.iter().any(|node| {
            node["kind"] == "method" && node["qualifiedName"] == "error.go::Error::Error"
        }));
        assert!(nodes.iter().any(|node| {
            node["kind"] == "method" && node["qualifiedName"] == "error.go::Error::ErrorOrNil"
        }));
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "constructs"
                && edge["fromNodeId"] == new_id
                && edge["toNodeId"] == error_id
                && edge["resolution"] == "exact"
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rust_generic_impl_methods_use_the_declared_type_qualified_name() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-rust-generic-{}",
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

        let mut request_value = valid_request();
        request_value["arguments"]["languages"] = json!(["rust"]);
        let request = parse_request(&request_value).unwrap();
        let graph = build_graph_at_root(&request, "test", &root, Instant::now())
            .unwrap()
            .graph;
        let nodes = graph["nodes"].as_array().unwrap();

        assert!(nodes.iter().any(|node| {
            node["kind"] == "method" && node["qualifiedName"] == "map.rs::Map::new"
        }));
        assert!(nodes.iter().any(|node| {
            node["kind"] == "method" && node["qualifiedName"] == "map.rs::Map::clear"
        }));
        assert!(!nodes.iter().any(|node| {
            node["kind"] == "method"
                && node["qualifiedName"]
                    .as_str()
                    .is_some_and(|name| name.contains("MapKV"))
        }));
        let map_id = nodes
            .iter()
            .find(|node| node["kind"] == "struct" && node["qualifiedName"] == "map.rs::Map")
            .and_then(|node| node["id"].as_str())
            .unwrap();
        let default_id = nodes
            .iter()
            .find(|node| {
                node["kind"] == "method" && node["qualifiedName"] == "map.rs::Map::default"
            })
            .and_then(|node| node["id"].as_str())
            .unwrap();
        let edges = graph["edges"].as_array().unwrap();
        assert!(edges.iter().any(|edge| {
            edge["kind"] == "constructs"
                && edge["fromNodeId"] == default_id
                && edge["toNodeId"] == map_id
                && edge["resolution"] == "exact"
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn graph_reports_recovered_syntax_without_failing_the_file() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-recovery-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("recover.ts"),
            "const incomplete = ;\nexport function stillWorks() { return 1; }\n",
        )
        .unwrap();

        let request = parse_request(&valid_request()).unwrap();
        let graph = build_graph_at_root(&request, "test", &root, Instant::now())
            .unwrap()
            .graph;

        let typescript_coverage = graph["coverage"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["language"] == "typescript")
            .unwrap();
        assert_eq!(typescript_coverage["failedFileCount"], 0);
        assert!(graph["diagnostics"].as_array().unwrap().iter().any(|item| {
            item["code"] == "parse_recovered"
                && item["locator"] == "workspace://recover.ts"
                && item["severity"] == "warning"
        }));
        assert!(!graph["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["code"] == "parse_failed"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn all_fourteen_language_fixtures_round_trip_through_sqlite() {
        let fixture_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../evals/code-intelligence/fixtures")
            .canonicalize()
            .unwrap();
        let scratch = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-sqlite-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&scratch);
        fs::create_dir_all(scratch.join("javascript")).unwrap();
        fs::create_dir_all(scratch.join("typescript")).unwrap();
        fs::write(
            scratch.join("javascript/index.js"),
            "export function target() { return 1; }\nexport function caller() { return target(); }\n",
        )
        .unwrap();
        fs::write(
            scratch.join("typescript/index.ts"),
            "export function target(): number { return 1; }\nexport function caller(): number { return target(); }\n",
        )
        .unwrap();

        let fixtures = [
            ("javascript", scratch.join("javascript")),
            ("typescript", scratch.join("typescript")),
            ("python", fixture_root.join("batch-b/python")),
            ("go", fixture_root.join("batch-b/go")),
            ("rust", fixture_root.join("batch-b/rust")),
            ("java", fixture_root.join("batch-c/java")),
            ("kotlin", fixture_root.join("batch-c/kotlin")),
            ("csharp", fixture_root.join("batch-c/csharp")),
            ("c", fixture_root.join("batch-d/c")),
            ("cpp", fixture_root.join("batch-d/cpp")),
            ("swift", fixture_root.join("batch-d/swift")),
            ("dart", fixture_root.join("batch-d/dart")),
            ("php", fixture_root.join("batch-e/php")),
            ("ruby", fixture_root.join("batch-e/ruby")),
        ];
        let options = SourceIndexOptions::new(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1.1.1",
        );
        for (language, root) in fixtures {
            let mut request_value = valid_request();
            request_value["arguments"]["languages"] = json!([language]);
            let request = parse_request(&request_value).unwrap();
            let graph = build_graph_at_root(&request, "1.1.1", &root, Instant::now())
                .unwrap()
                .graph;
            let input = index_generation_from_graph(&graph, &root).unwrap();
            assert_eq!(
                input.structural_fingerprint,
                graph["graphFingerprint"].as_str().unwrap(),
                "{language}"
            );
            assert!(!input.nodes.is_empty(), "{language}: nodes");
            assert!(!input.edges.is_empty(), "{language}: edges");
            let stored_files = input
                .files
                .iter()
                .map(|file| file.locator.as_str())
                .collect::<BTreeSet<_>>();
            for node in &input.nodes {
                assert!(
                    stored_files.contains(locator_file(&node.locator)),
                    "{language}: missing file for {} at {}; files={stored_files:#?}",
                    node.canonical_id,
                    node.locator
                );
            }

            let path = scratch.join(format!("indexes/{language}/index.sqlite"));
            let mut writer = SourceIndex::open(&path, &options).unwrap();
            let committed = writer
                .commit_generation(&input)
                .unwrap_or_else(|error| panic!("{language}: {error:#}"));
            assert_eq!(committed.structural_fingerprint, input.structural_fingerprint);
            drop(writer);
            let reader = SourceIndex::open_read_only(&path, &options).unwrap();
            let loaded = reader.load_active_generation().unwrap().unwrap();
            assert_eq!(loaded.input, input, "{language}: normalized graph drift");
            assert_eq!(
                loaded.input.nodes.first().map(|node| (
                    node.canonical_id.as_str(),
                    node.qualified_name.as_str()
                )),
                input.nodes.first().map(|node| (
                    node.canonical_id.as_str(),
                    node.qualified_name.as_str()
                )),
                "{language}: sampled node truth"
            );
            assert_eq!(
                loaded.input.edges.first().map(|edge| (
                    edge.source_id.as_str(),
                    edge.target_id.as_str(),
                    edge.kind.as_str()
                )),
                input.edges.first().map(|edge| (
                    edge.source_id.as_str(),
                    edge.target_id.as_str(),
                    edge.kind.as_str()
                )),
                "{language}: sampled edge truth"
            );
        }

        fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn mixed_language_incremental_refresh_matches_clean_graph_and_reparses_only_affected_files() {
        let root = std::env::temp_dir().join(format!(
            "memory-recall-code-intelligence-incremental-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("util.ts"),
            "export function target(): string { return 'one'; }\n",
        )
        .unwrap();
        fs::write(
            root.join("app.ts"),
            "import { target } from './util';\nexport function run(): string { return target(); }\n",
        )
        .unwrap();
        fs::write(
            root.join("unrelated.py"),
            "def unrelated():\n    return 'stable'\n",
        )
        .unwrap();
        let mut request_value = valid_request();
        request_value["arguments"]["languages"] = json!(["typescript", "python"]);
        let request = parse_request(&request_value).unwrap();
        let base_graph = build_graph_at_root(&request, "1.1.1", &root, Instant::now())
            .unwrap()
            .graph;
        let base = index_generation_from_graph(&base_graph, &root).unwrap();
        let options = SourceIndexOptions::new(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1.1.1",
        );
        let path = root.join("index/index.sqlite");
        let mut index = SourceIndex::open(&path, &options).unwrap();
        index.commit_generation(&base).unwrap();

        fs::write(
            root.join("util.ts"),
            "export function target(): string { return 'two'; }\n",
        )
        .unwrap();
        let clean_graph = build_graph_at_root(&request, "1.1.1", &root, Instant::now())
            .unwrap()
            .graph;
        let clean = index_generation_from_graph(&clean_graph, &root).unwrap();
        let current = clean
            .files
            .iter()
            .map(|file| DiscoveredFile {
                locator: file.locator.clone(),
                content_hash: file.content_hash.clone(),
                byte_size: file.byte_size,
            })
            .collect::<Vec<_>>();
        let plan = index
            .plan_refresh(&current, None, &RefreshBounds::default())
            .unwrap();
        assert_eq!(
            plan.invalidated_files,
            ["workspace://app.ts", "workspace://util.ts"]
        );
        assert!(!plan
            .invalidated_files
            .contains(&"workspace://unrelated.py".to_string()));

        let invalidated = plan
            .invalidated_files
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut partial_options = IngestOptions::new(&root);
        partial_options.only_sources = Some(invalidated.clone());
        let partial_report = extract_repo(&partial_options).unwrap();
        assert_eq!(partial_report.parsed_file_count, 2);

        let replacement = select_generation_files(&clean, &invalidated);
        index.commit_incremental(&plan, &replacement).unwrap();
        let loaded = index.load_active_generation().unwrap().unwrap().input;
        let expected_fingerprint = normalized_generation_fingerprint(&clean).unwrap();
        assert_eq!(loaded.structural_fingerprint, expected_fingerprint);
        assert_eq!(
            normalized_generation_fingerprint(&loaded).unwrap(),
            expected_fingerprint
        );
        assert!(loaded
            .nodes
            .iter()
            .any(|node| node.locator.starts_with("workspace://unrelated.py")));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_pinned_repositories_incremental_refresh_matches_clean_rebuild() {
        let Ok(specification) = std::env::var("MEMORY_RECALL_PINNED_INCREMENTAL_ROOTS") else {
            return;
        };
        for entry in specification
            .split(';')
            .filter(|entry| !entry.is_empty())
        {
            let (language, source_root) = entry
                .split_once('=')
                .expect("pinned root must use language=/absolute/path");
            let source_root = std::path::PathBuf::from(source_root)
                .canonicalize()
                .unwrap();
            let scratch = std::env::temp_dir().join(format!(
                "memory-recall-pinned-incremental-{language}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&scratch);
            fs::create_dir_all(&scratch).unwrap();
            let hashes = discover_file_hashes(&IngestOptions::new(&source_root)).unwrap();
            assert!(!hashes.is_empty(), "{language}: no supported files");
            for item in hashes.iter().take(250) {
                let relative = item.source.strip_prefix("workspace://").unwrap();
                let destination = scratch.join(relative);
                fs::create_dir_all(destination.parent().unwrap()).unwrap();
                fs::copy(source_root.join(relative), destination).unwrap();
            }
            let mut request_value = valid_request();
            request_value["arguments"]["languages"] = json!([language]);
            request_value["arguments"]["maxFiles"] = json!(500);
            let request = parse_request(&request_value).unwrap();
            let base_graph = build_graph_at_root(&request, "1.1.1", &scratch, Instant::now())
                .unwrap()
                .graph;
            let base = index_generation_from_graph(&base_graph, &scratch).unwrap();
            assert!(!base.nodes.is_empty(), "{language}: no nodes");
            let options = SourceIndexOptions::new(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "1.1.1",
            );
            let path = scratch.join(".local/index.sqlite");
            let mut index = SourceIndex::open(&path, &options).unwrap();
            index.commit_generation(&base).unwrap();

            let changed = base
                .files
                .iter()
                .find(|file| file.parse_state == "parsed")
                .unwrap()
                .locator
                .strip_prefix("workspace://")
                .unwrap()
                .to_string();
            use std::io::Write as _;
            writeln!(
                fs::OpenOptions::new()
                    .append(true)
                    .open(scratch.join(&changed))
                    .unwrap()
            )
            .unwrap();

            let clean_graph = build_graph_at_root(&request, "1.1.1", &scratch, Instant::now())
                .unwrap()
                .graph;
            let clean = index_generation_from_graph(&clean_graph, &scratch).unwrap();
            let current = clean
                .files
                .iter()
                .map(|file| DiscoveredFile {
                    locator: file.locator.clone(),
                    content_hash: file.content_hash.clone(),
                    byte_size: file.byte_size,
                })
                .collect::<Vec<_>>();
            let plan = index
                .plan_refresh(&current, None, &RefreshBounds::default())
                .unwrap();
            assert!(!plan.invalidated_files.is_empty(), "{language}: no invalidation");
            let invalidated = plan
                .invalidated_files
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>();
            let mut partial_options = IngestOptions::new(&scratch);
            partial_options.only_sources = Some(invalidated.clone());
            let partial = extract_repo(&partial_options).unwrap();
            assert!(
                partial.parsed_file_count <= invalidated.len(),
                "{language}: reparsed outside invalidation"
            );
            let replacement = select_generation_files(&clean, &invalidated);
            index.commit_incremental(&plan, &replacement).unwrap();
            let loaded = index.load_active_generation().unwrap().unwrap().input;
            let mut expected = clean.clone();
            expected.structural_fingerprint = loaded.structural_fingerprint.clone();
            expected
                .files
                .sort_by(|left, right| left.locator.cmp(&right.locator));
            expected
                .nodes
                .sort_by(|left, right| left.canonical_id.cmp(&right.canonical_id));
            expected
                .edges
                .sort_by(|left, right| left.canonical_id.cmp(&right.canonical_id));
            expected
                .unresolved
                .sort_by(|left, right| left.canonical_id.cmp(&right.canonical_id));
            expected.coverage.sort_by(|left, right| {
                left.language
                    .cmp(&right.language)
                    .then_with(|| left.capability.cmp(&right.capability))
            });
            expected
                .diagnostics
                .sort_by(|left, right| left.canonical_id.cmp(&right.canonical_id));
            assert_eq!(loaded.reason, expected.reason, "{language}: reason");
            assert_eq!(loaded.created_at, expected.created_at, "{language}: created_at");
            assert_eq!(
                loaded.ignore_fingerprint, expected.ignore_fingerprint,
                "{language}: ignore fingerprint"
            );
            assert_eq!(loaded.files.len(), expected.files.len(), "{language}: files");
            assert_eq!(loaded.nodes.len(), expected.nodes.len(), "{language}: nodes");
            assert_eq!(loaded.edges.len(), expected.edges.len(), "{language}: edges");
            for (position, (left, right)) in loaded.files.iter().zip(&expected.files).enumerate() {
                assert_eq!(left, right, "{language}: file record {position}");
            }
            for (position, (left, right)) in loaded.nodes.iter().zip(&expected.nodes).enumerate() {
                assert_eq!(left, right, "{language}: node record {position}");
            }
            for (position, (left, right)) in loaded.edges.iter().zip(&expected.edges).enumerate() {
                assert_eq!(left, right, "{language}: edge record {position}");
            }
            assert_eq!(
                loaded.unresolved, expected.unresolved,
                "{language}: unresolved"
            );
            assert_eq!(loaded.coverage, expected.coverage, "{language}: coverage");
            assert_eq!(
                loaded.diagnostics, expected.diagnostics,
                "{language}: diagnostics"
            );
            assert_eq!(
                normalized_generation_fingerprint(&loaded).unwrap(),
                normalized_generation_fingerprint(&clean).unwrap(),
                "{language}: incremental graph differs from clean rebuild"
            );
            fs::remove_dir_all(scratch).unwrap();
        }
    }
}
