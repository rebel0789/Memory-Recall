package api

import (
	"net/http"

	"example.com/demo/service"
)

func Item() {}

func Register(router *Router) {
	router.GET("/items/:item_id", Item)
	http.HandleFunc("POST /legacy/{item_id}", Item)
}

func Build() *service.Service {
	return &service.Service{}
}
