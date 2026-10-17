/** Domain failure. HTTP adapters may use status without owning the service. */
export class ServiceError extends Error{
 constructor(message,status=400){super(message);this.status=status;}
}
