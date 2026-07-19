#ifndef ITEM_H
#define ITEM_H

typedef struct Item {
  const char *id;
} Item;

Item item_find(const char *id);

#endif
