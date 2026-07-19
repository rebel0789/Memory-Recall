import Vapor

func routes(_ app: Application, service: ItemService) {
    app.get("items", ":id") { request in
        service.find(id: request.parameters.get("id") ?? "")
    }
}
