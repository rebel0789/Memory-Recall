package com.acme.api;

import com.acme.model.Item;
import com.acme.service.ItemService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/items")
public final class ItemController {
    private final ItemService service;

    public ItemController(ItemService service) {
        this.service = service;
    }

    @GetMapping("/{id}")
    public Item get(String id) {
        return service.find(id);
    }

    public Item ambiguous(String id) {
        return service.load(id);
    }
}
