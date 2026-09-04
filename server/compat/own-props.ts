// module 5.1  server/compat/own-props.ts -- keep the shims' methods reachable after Express reparents them

//Purpose: For each name in names, make sure instance has that member as an own property. If it's already an own property, 
// leave it. If it currently lives somewhere up the prototype chain, copy its descriptor down onto the instance directly (non-enumerable). 
// If it isn't found anywhere at all, throw immediately.
export function pinToInstance(instance: object, names: readonly string[]): void {
  for (const name of names) {
    if (Object.hasOwn(instance, name)) continue

    const descriptor = inheritedDescriptor(instance, name)
    if (descriptor === undefined) {
      throw new Error(`wirehttp: cannot pin '${name}' -- no such member on the prototype chain`)
    }

    // Pinned members are made non-enumerable(Non-enumerable means a property doesn't show up when you normally list an object's properties.)
    //  however they were declared. A prototype
    // method is invisible to `Object.keys`, `for...in` and `JSON.stringify`, and anything
    // standing in for one has to be equally invisible, or middleware that enumerates or
    // serialises the object starts seeing functions that were never there before.
    Object.defineProperty(instance, name, { ...descriptor, enumerable: false })
  }
}


export function refuseMembers(
  names: readonly string[],
  kind: 'method' | 'property' = 'method',
): PropertyDescriptorMap {
  const descriptors: PropertyDescriptorMap = {}

  for (const name of names) {
    const refuse = (): never => {
      throw new Error(`wirehttp: ${name} is unsupported by design -- see DECISIONS.md`)
    }
    descriptors[name] =
      kind === 'method'
        ? { value: refuse, writable: true, enumerable: false, configurable: true }
        : { get: refuse, enumerable: false, configurable: true }
  }

  return descriptors
}

/** The descriptor for `name` from the nearest prototype that defines it. */
function inheritedDescriptor(instance: object, name: string): PropertyDescriptor | undefined {
  let proto: object | null = Object.getPrototypeOf(instance)

  while (proto !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name)
    if (descriptor !== undefined) return descriptor
    proto = Object.getPrototypeOf(proto)
  }

  return undefined
}
