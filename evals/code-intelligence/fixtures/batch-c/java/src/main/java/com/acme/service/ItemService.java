package com.acme.service;

import com.acme.model.Item;

interface ItemLoader {
    Item find(String id);
}

public final class ItemService implements ItemLoader {
    public Item find(String id) {
        return new Item(id);
    }

    public Item load(String id) {
        return find(id);
    }

    public Item load(long id) {
        return find(Long.toString(id));
    }
}
