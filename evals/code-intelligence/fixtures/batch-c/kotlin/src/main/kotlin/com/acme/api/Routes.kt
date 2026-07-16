package com.acme.api

import com.acme.service.ItemService
import io.ktor.server.application.Application
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.routing

fun Application.itemRoutes(service: ItemService) {
    routing {
        get("/items/{id}") {
            service.find("demo")
        }
    }
}
