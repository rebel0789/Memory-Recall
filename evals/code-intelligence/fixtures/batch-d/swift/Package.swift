// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ItemApp",
    products: [.executable(name: "ItemApp", targets: ["App"])],
    targets: [.executableTarget(name: "App", dependencies: [.product(name: "Vapor", package: "vapor")])]
)
